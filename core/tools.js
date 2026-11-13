/* Tool definitions: JSON Schemas (input + output), MCP annotations, the minimum role, and the handler.
   Handlers are pure functions of (args, ctx) so the Node server and the browser playground share them. */
import { METRICS_SCHEMA } from './seed.js';

export class ToolError extends Error { constructor(message, hint, code) { super(message); this.hint = hint || ''; this.code = code || 'TOOL_ERROR'; } }

const EMP_ID = { type: 'string', pattern: '^E\\d{3}$', description: 'Employee id, e.g. E004', examples: ['E004'] };
const TICKET_ID = { type: 'string', pattern: '^IT-\\d{4}$', description: 'Ticket id, e.g. IT-1003', examples: ['IT-1003'] };
const LIMIT = (def, max) => ({ type: 'integer', minimum: 1, maximum: max, default: def, description: 'Max items per page (default ' + def + ', max ' + max + ')' });
const CURSOR = { type: 'string', maxLength: 64, description: 'Opaque cursor from a previous page (next_cursor)' };
const PAGE_OUT = { next_cursor: { type: ['string', 'null'], description: 'Pass as cursor to get the next page; null when done' }, total: { type: 'integer' } };
const CONFIRM = { type: 'boolean', default: false, description: 'false (default) = dry run that only previews the change. true = actually apply it. Ask the user before sending true.' };
const STATUSES = ['open', 'in_progress', 'blocked', 'resolved', 'closed'];
const PRIORITIES = ['P1', 'P2', 'P3', 'P4'];
const CATEGORIES = ['hardware', 'software', 'access', 'network', 'security', 'other'];
const TEAMS = ['platform', 'payments', 'identity', 'it-helpdesk'];

export function encodeCursor(offset) { return 'o' + Number(offset).toString(36); }
export function decodeCursor(c) {
  if (c == null || c === '') return 0;
  const m = /^o([0-9a-z]{1,8})$/.exec(String(c));
  if (!m) throw new ToolError('That cursor is not valid.', 'Pass the next_cursor value exactly as returned, or omit it to start from the first page.', 'BAD_CURSOR');
  return parseInt(m[1], 36);
}
function page(items, args, def) {
  const limit = args.limit || def; const off = decodeCursor(args.cursor);
  const slice = items.slice(off, off + limit);
  return { slice, next_cursor: off + limit < items.length ? encodeCursor(off + limit) : null, total: items.length };
}
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
function publicEmployee(e) { return { id: e.id, name: e.name, email: e.email, title: e.title, department: e.department, team: e.team, location: e.location }; }
function nameOf(store, id) { const e = id && store.employee(id); return e ? e.name : null; }
function needEmployee(store, id, field) {
  const e = store.employee(id);
  if (!e) throw new ToolError('No employee with ' + (field || 'id') + ' "' + id + '".', 'Use directory_search to find the right employee id (format E001).', 'NOT_FOUND');
  return e;
}
function needTicket(store, id) {
  const t = store.ticket(id);
  if (!t) throw new ToolError('Ticket ' + id + ' does not exist.', 'Use tickets_list to see existing tickets.', 'NOT_FOUND');
  return t;
}
function ticketSummary(store, t) { return { id: t.id, title: t.title, status: t.status, priority: t.priority, category: t.category, requester: nameOf(store, t.requester_id), assignee: nameOf(store, t.assignee_id), updated_at: t.updated_at }; }
function tokenize(q) { return norm(q).split(/[^a-z0-9$]+/).filter((w) => w.length > 1 && !STOP.has(w)); }
const STOP = new Set(['the', 'a', 'an', 'is', 'are', 'of', 'to', 'for', 'and', 'or', 'in', 'on', 'what', 'how', 'many', 'do', 'does', 'our', 'we', 'my', 'i', 'can', 'get', 'about', 'policy', 'with', 'per']);
export function searchWiki(pages, query, limit) {
  const terms = tokenize(query);
  const scored = pages.map((p) => {
    const title = norm(p.title); const body = norm(p.body); const tags = norm(p.tags.join(' '));
    let score = 0; terms.forEach((t) => { if (title.includes(t)) score += 5; if (tags.includes(t)) score += 3; const n = body.split(t).length - 1; score += Math.min(n, 6); });
    let snippet = '';
    const lines = p.body.split('\n').filter((l) => l.trim() && !l.startsWith('#') && !/^\|?\s*-{3}/.test(l));
    const best = lines.map((l) => ({ l, s: terms.reduce((a, t) => a + (norm(l).includes(t) ? 1 : 0), 0) })).sort((a, b) => b.s - a.s)[0];
    if (best) snippet = best.l.replace(/\*\*/g, '').slice(0, 240);
    return { slug: p.slug, title: p.title, score, snippet, uri: 'wiki://pages/' + p.slug };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
  return scored.slice(0, limit || 5);
}
export function oncallAt(store, team, atMs) {
  const oc = store.oncall; const anchor = Date.parse(oc.anchor); const week = 7 * 86400000;
  const w = Math.floor((atMs - anchor) / week);
  const t = oc.teams[team]; const n = t.rotation.length; const idx = ((w % n) + n) % n;
  const person = (id) => { const e = store.employee(id); return { id: e.id, name: e.name, email: e.email, phone: e.phone }; };
  return { team, primary: person(t.rotation[idx]), secondary: person(t.rotation[(idx + 1) % n]), escalation: person(t.escalation), shift_start: new Date(anchor + w * week).toISOString(), shift_end: new Date(anchor + (w + 1) * week).toISOString() };
}
function expenseNotes(x) {
  const n = [];
  if (x.amount > 2500 || /business class/i.test(x.notes)) n.push('Needs VP approval (over $2,500 or business class).');
  else if (x.amount >= 500) n.push('Needs Finance Manager approval ($500 to $2,500).');
  if (x.category === 'meals' && /on-call/i.test(x.notes) && x.amount > 40) n.push('Over the $40 on-call dinner limit.');
  if (x.category === 'lodging' && x.amount > 350) n.push('Lodging may exceed the nightly limit; check the number of nights.');
  if (/per-person limit/i.test(x.notes)) n.push('Customer meal may exceed $60 per person.');
  return n;
}

export const TOOLS = [
  {
    name: 'directory_search', title: 'Search the employee directory', minRole: 'viewer',
    description: 'Find employees by name, title, team, skill or location. Returns public profile fields only (no phone numbers). Paginated.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: 'object', additionalProperties: false, properties: { query: { type: 'string', maxLength: 100, description: 'Free text: name, title, skill, team or location. Empty lists everyone.' }, department: { type: 'string', enum: ['Executive', 'Engineering', 'Operations', 'People', 'Finance', 'Sales', 'Product'] }, location: { type: 'string', maxLength: 60 }, limit: LIMIT(10, 50), cursor: CURSOR } },
    outputSchema: { type: 'object', required: ['employees', 'next_cursor', 'total'], properties: Object.assign({ employees: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, email: { type: 'string' }, title: { type: 'string' }, department: { type: 'string' }, team: { type: 'string' }, location: { type: 'string' } } } } }, PAGE_OUT) },
    run(a, { store }) {
      const terms = tokenize(a.query || '');
      let list = store.employees.filter((e) => {
        if (a.department && e.department !== a.department) return false;
        if (a.location && !norm(e.location).includes(norm(a.location))) return false;
        const hay = norm([e.name, e.title, e.team, e.department, e.location, e.skills.join(' ')].join(' '));
        return terms.every((t) => hay.includes(t));
      });
      const p = page(list, a, 10);
      return { structured: { employees: p.slice.map(publicEmployee), next_cursor: p.next_cursor, total: p.total }, summary: p.total + ' employee(s) matched' + (p.next_cursor ? '; more pages available' : '') + '.' };
    }
  },
  {
    name: 'directory_get_employee', title: 'Get one employee profile', minRole: 'viewer',
    description: 'Full profile for one employee by id or email (give one of them): manager, direct reports, phone, skills. Salary band is included only for the admin role.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: 'object', additionalProperties: false, properties: { id: EMP_ID, email: { type: 'string', format: 'email', maxLength: 120 } } },
    outputSchema: { type: 'object', required: ['id', 'name', 'email'], properties: { id: { type: 'string' }, name: { type: 'string' }, email: { type: 'string' }, phone: { type: 'string' }, title: { type: 'string' }, department: { type: 'string' }, team: { type: 'string' }, location: { type: 'string' }, start_date: { type: 'string' }, skills: { type: 'array', items: { type: 'string' } }, manager: { type: ['object', 'null'] }, direct_reports: { type: 'array' }, salary_band: { type: 'string' } } },
    run(a, { store, principal }) {
      if (!a.id && !a.email) throw new ToolError('Provide either id or email.', 'Example: { "id": "E004" } or { "email": "luis.ortega@brightwave.example" }.', 'MISSING_FIELD');
      const e = needEmployee(store, a.id || a.email, a.id ? 'id' : 'email');
      const m = e.manager_id ? store.employee(e.manager_id) : null;
      const out = Object.assign(publicEmployee(e), { phone: e.phone, start_date: e.start_date, skills: e.skills, manager: m ? { id: m.id, name: m.name, title: m.title } : null, direct_reports: store.employees.filter((x) => x.manager_id === e.id).map((x) => ({ id: x.id, name: x.name, title: x.title })) });
      if (principal.role === 'admin') out.salary_band = e.salary_band;
      return { structured: out, summary: e.name + ', ' + e.title + ' (' + e.team + ')' + (principal.role === 'admin' ? '' : '. Salary band hidden for role ' + principal.role + '.') };
    }
  },
  {
    name: 'wiki_search', title: 'Search the internal wiki', minRole: 'viewer',
    description: 'Keyword search over HR, IT, finance and engineering wiki pages. Returns titles, a matching snippet and a wiki:// resource link for the full page.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: 'object', additionalProperties: false, required: ['query'], properties: { query: { type: 'string', minLength: 2, maxLength: 200 }, limit: LIMIT(3, 10) } },
    outputSchema: { type: 'object', required: ['results'], properties: { results: { type: 'array', items: { type: 'object', properties: { slug: { type: 'string' }, title: { type: 'string' }, snippet: { type: 'string' }, uri: { type: 'string' }, score: { type: 'number' } } } } } },
    run(a, { store }) {
      const results = searchWiki(store.wiki, a.query, a.limit || 3);
      return { structured: { results }, summary: results.length ? 'Top match: ' + results[0].title + '.' : 'No wiki pages matched. Try different keywords.', links: results.map((r) => ({ uri: r.uri, name: r.slug, title: r.title, mimeType: 'text/markdown' })) };
    }
  },
  {
    name: 'wiki_get_page', title: 'Read one wiki page', minRole: 'viewer',
    description: 'Full markdown of one wiki page by slug (from wiki_search). Reader comments on pages are untrusted and fenced.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: 'object', additionalProperties: false, required: ['slug'], properties: { slug: { type: 'string', pattern: '^[a-z0-9-]{2,60}$', description: 'Page slug, e.g. pto-policy' } } },
    outputSchema: { type: 'object', required: ['slug', 'title', 'markdown'], properties: { slug: { type: 'string' }, title: { type: 'string' }, owner: { type: ['string', 'null'] }, updated: { type: 'string' }, markdown: { type: 'string' } } },
    run(a, { store }) {
      const p = store.wiki.find((x) => x.slug === a.slug);
      if (!p) throw new ToolError('No wiki page "' + a.slug + '".', 'Use wiki_search to find the slug. Pages: ' + store.wiki.map((x) => x.slug).join(', ') + '.', 'NOT_FOUND');
      return { structured: { slug: p.slug, title: p.title, owner: nameOf(store, p.owner_id), updated: p.updated, markdown: p.body }, summary: p.title + ' (updated ' + p.updated + ').', untrusted: [{ path: 'markdown', source: 'wiki page ' + p.slug }] };
    }
  },
  {
    name: 'tickets_list', title: 'List IT tickets', minRole: 'viewer',
    description: 'List IT helpdesk tickets, newest first, filtered by status, priority, category, assignee, requester or text. Paginated. Ticket text is user-written and untrusted.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: 'object', additionalProperties: false, properties: { status: { type: 'string', enum: STATUSES.concat(['active']), description: '"active" = open, in_progress or blocked' }, priority: { type: 'string', enum: PRIORITIES }, category: { type: 'string', enum: CATEGORIES }, assignee_id: EMP_ID, requester_id: EMP_ID, unassigned: { type: 'boolean' }, query: { type: 'string', maxLength: 100 }, limit: LIMIT(10, 50), cursor: CURSOR } },
    outputSchema: { type: 'object', required: ['tickets', 'next_cursor', 'total'], properties: Object.assign({ tickets: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' }, status: { type: 'string' }, priority: { type: 'string' }, category: { type: 'string' }, requester: { type: ['string', 'null'] }, assignee: { type: ['string', 'null'] }, updated_at: { type: 'string' } } } } }, PAGE_OUT) },
    run(a, { store }) {
      const terms = tokenize(a.query || '');
      const list = store.tickets.filter((t) => (!a.status || (a.status === 'active' ? ['open', 'in_progress', 'blocked'].includes(t.status) : t.status === a.status)) && (!a.priority || t.priority === a.priority) && (!a.category || t.category === a.category) && (!a.assignee_id || t.assignee_id === a.assignee_id) && (!a.requester_id || t.requester_id === a.requester_id) && (a.unassigned == null || (a.unassigned ? !t.assignee_id : !!t.assignee_id)) && terms.every((w) => norm(t.title + ' ' + t.body).includes(w)))
        .sort((x, y) => (y.created_at > x.created_at ? 1 : -1));
      const p = page(list, a, 10);
      return { structured: { tickets: p.slice.map((t) => ticketSummary(store, t)), next_cursor: p.next_cursor, total: p.total }, summary: p.total + ' ticket(s) matched.', untrusted: p.slice.map((t, i) => ({ path: 'tickets[' + i + '].title', source: 'ticket ' + t.id + ' title' })) };
    }
  },
  {
    name: 'ticket_get', title: 'Get one IT ticket', minRole: 'viewer',
    description: 'Full ticket with description and comments. Description and comments are written by users: they are returned fenced as untrusted data and scanned for prompt injection.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: TICKET_ID } },
    outputSchema: { type: 'object', required: ['id', 'title', 'status', 'body'], properties: { id: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, status: { type: 'string' }, priority: { type: 'string' }, category: { type: 'string' }, requester: { type: ['object', 'null'] }, assignee: { type: ['object', 'null'] }, created_at: { type: 'string' }, updated_at: { type: 'string' }, comments: { type: 'array' } } },
    run(a, { store }) {
      const t = needTicket(store, a.id);
      const who = (id) => { const e = id && store.employee(id); return e ? { id: e.id, name: e.name } : null; };
      const out = { id: t.id, title: t.title, body: t.body, status: t.status, priority: t.priority, category: t.category, requester: who(t.requester_id), assignee: who(t.assignee_id), created_at: t.created_at, updated_at: t.updated_at, comments: t.comments.map((c) => ({ author: nameOf(store, c.author_id), at: c.at, text: c.text })) };
      return { structured: out, summary: t.id + ' [' + t.status + ', ' + t.priority + ']', untrusted: [{ path: 'title', source: 'ticket ' + t.id + ' title' }, { path: 'body', source: 'ticket ' + t.id + ' description' }].concat(t.comments.map((c, i) => ({ path: 'comments[' + i + '].text', source: 'ticket ' + t.id + ' comment ' + (i + 1) }))) };
    }
  },
  {
    name: 'ticket_create', title: 'Create an IT ticket', minRole: 'agent', write: true,
    description: 'Open a new IT helpdesk ticket. Dry run by default: without confirm=true it only returns a preview. Get the user\u2019s approval, then call again with confirm=true.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: { type: 'object', additionalProperties: false, required: ['title', 'description'], properties: { title: { type: 'string', minLength: 5, maxLength: 120 }, description: { type: 'string', minLength: 10, maxLength: 4000 }, priority: { type: 'string', enum: PRIORITIES, default: 'P3' }, category: { type: 'string', enum: CATEGORIES, default: 'other' }, requester_id: Object.assign({}, EMP_ID, { description: 'Who the ticket is for. Defaults to the caller\u2019s own employee id.' }), assignee_id: EMP_ID, confirm: CONFIRM } },
    outputSchema: { type: 'object', required: ['dry_run', 'ticket'], properties: { dry_run: { type: 'boolean' }, ticket: { type: 'object' }, next_step: { type: 'string' } } },
    preview(a, ctx) { const t = buildTicket(a, ctx, true); return { structured: { dry_run: true, ticket: t, next_step: 'Nothing was created. Show this preview to the user; if they approve, call ticket_create again with the same arguments and confirm=true.' }, summary: 'Dry run: would create ' + t.id + ' "' + t.title + '" (' + t.priority + ').' }; },
    run(a, ctx) { const t = buildTicket(a, ctx, false); ctx.store.insertTicket(t); return { structured: { dry_run: false, ticket: t }, summary: 'Created ' + t.id + ' "' + t.title + '" (' + t.priority + ', ' + t.category + ').', changed: true }; }
  },
  {
    name: 'ticket_update', title: 'Update an IT ticket', minRole: 'agent', write: true,
    description: 'Change a ticket\u2019s status, priority or assignee and/or add a comment. Dry run by default; confirm=true applies it. Closing a ticket needs the admin role (agents can resolve).',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: TICKET_ID, status: { type: 'string', enum: STATUSES }, priority: { type: 'string', enum: PRIORITIES }, assignee_id: EMP_ID, comment: { type: 'string', minLength: 2, maxLength: 2000 }, confirm: CONFIRM } },
    outputSchema: { type: 'object', required: ['dry_run', 'ticket', 'changes'], properties: { dry_run: { type: 'boolean' }, ticket: { type: 'object' }, changes: { type: 'array', items: { type: 'object', properties: { field: { type: 'string' }, from: {}, to: {} } } }, next_step: { type: 'string' } } },
    preview(a, ctx) { const r = planUpdate(a, ctx); return { structured: { dry_run: true, ticket: ticketSummary(ctx.store, r.after), changes: r.changes, next_step: 'Nothing was changed. If the user approves, call ticket_update again with the same arguments and confirm=true.' }, summary: 'Dry run for ' + a.id + ': ' + describeChanges(r.changes) + '.' }; },
    run(a, ctx) { const r = planUpdate(a, ctx); ctx.store.replaceTicket(r.after); return { structured: { dry_run: false, ticket: ticketSummary(ctx.store, r.after), changes: r.changes }, summary: 'Updated ' + a.id + ': ' + describeChanges(r.changes) + '.', changed: true }; }
  },
  {
    name: 'oncall_lookup', title: 'Who is on call', minRole: 'viewer',
    description: 'Primary, secondary and escalation contacts for a team\u2019s on-call rotation at a given time (default: now). Rotations hand off Mondays 09:00 Central.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: 'object', additionalProperties: false, properties: { team: { type: 'string', enum: TEAMS, description: 'Omit for all teams' }, at: { type: 'string', format: 'date-time', description: 'ISO 8601 time; default now' } } },
    outputSchema: { type: 'object', required: ['at', 'shifts'], properties: { at: { type: 'string' }, shifts: { type: 'array', items: { type: 'object', properties: { team: { type: 'string' }, primary: { type: 'object' }, secondary: { type: 'object' }, escalation: { type: 'object' }, shift_start: { type: 'string' }, shift_end: { type: 'string' } } } } } },
    run(a, { store, now }) {
      const at = a.at ? Date.parse(a.at) : now();
      const shifts = (a.team ? [a.team] : TEAMS).map((t) => oncallAt(store, t, at));
      return { structured: { at: new Date(at).toISOString(), shifts }, summary: shifts.map((s) => s.team + ': ' + s.primary.name + ' (primary), ' + s.secondary.name + ' (secondary)').join('; ') + '.' };
    }
  },
  {
    name: 'asset_lookup', title: 'Look up IT assets', minRole: 'viewer',
    description: 'Find laptops, monitors, phones, printers and licenses by asset tag, assigned employee, type, status or model text. Paginated.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: 'object', additionalProperties: false, properties: { tag: { type: 'string', pattern: '^[A-Z]{2}-[A-Z0-9]{4,8}$', examples: ['LT-0004'] }, assigned_to: EMP_ID, type: { type: 'string', enum: ['laptop', 'monitor', 'dock', 'phone', 'printer', 'license'] }, status: { type: 'string', enum: ['in_use', 'spare', 'repair', 'retired'] }, query: { type: 'string', maxLength: 80 }, warranty_expires_before: { type: 'string', format: 'date' }, limit: LIMIT(10, 50), cursor: CURSOR } },
    outputSchema: { type: 'object', required: ['assets', 'next_cursor', 'total'], properties: Object.assign({ assets: { type: 'array', items: { type: 'object' } } }, PAGE_OUT) },
    run(a, { store }) {
      const terms = tokenize(a.query || '');
      const list = store.assets.filter((x) => (!a.tag || x.tag === a.tag) && (!a.assigned_to || x.assigned_to === a.assigned_to) && (!a.type || x.type === a.type) && (!a.status || x.status === a.status) && (!a.warranty_expires_before || x.warranty_end < a.warranty_expires_before) && terms.every((t) => norm(x.model + ' ' + x.type + ' ' + (x.location || '')).includes(t)));
      if (a.tag && !list.length) throw new ToolError('No asset with tag ' + a.tag + '.', 'Tags look like LT-0004 (laptop), MN-0021 (monitor), SW-FIGMA (license).', 'NOT_FOUND');
      const p = page(list, a, 10);
      return { structured: { assets: p.slice.map((x) => Object.assign({}, x, { assigned_to_name: nameOf(store, x.assigned_to) })), next_cursor: p.next_cursor, total: p.total }, summary: p.total + ' asset(s) matched.' };
    }
  },
  {
    name: 'expense_lookup', title: 'Look up expense reports', minRole: 'agent',
    description: 'Search expense reports by employee, status, category, date range and amount, with totals and policy notes (approval thresholds, on-call meal limit). Read-only.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: 'object', additionalProperties: false, properties: { employee_id: EMP_ID, status: { type: 'string', enum: ['submitted', 'approved', 'rejected', 'reimbursed'] }, category: { type: 'string', enum: ['travel', 'lodging', 'meals', 'conference', 'software', 'training', 'equipment', 'internet'] }, from: { type: 'string', format: 'date' }, to: { type: 'string', format: 'date' }, min_amount: { type: 'number', minimum: 0 }, limit: LIMIT(20, 50), cursor: CURSOR } },
    outputSchema: { type: 'object', required: ['expenses', 'total_amount_usd', 'next_cursor', 'total'], properties: Object.assign({ expenses: { type: 'array', items: { type: 'object' } }, total_amount_usd: { type: 'number' }, by_status: { type: 'object' } }, PAGE_OUT) },
    run(a, { store }) {
      if (a.from && a.to && a.from > a.to) throw new ToolError('"from" (' + a.from + ') is after "to" (' + a.to + ').', 'Swap the dates.', 'BAD_RANGE');
      const list = store.expenses.filter((x) => (!a.employee_id || x.employee_id === a.employee_id) && (!a.status || x.status === a.status) && (!a.category || x.category === a.category) && (!a.from || x.date >= a.from) && (!a.to || x.date <= a.to) && (a.min_amount == null || x.amount >= a.min_amount)).sort((x, y) => (y.date > x.date ? 1 : -1));
      const total = Math.round(list.reduce((s, x) => s + x.amount, 0) * 100) / 100;
      const by = {}; list.forEach((x) => { by[x.status] = Math.round(((by[x.status] || 0) + x.amount) * 100) / 100; });
      const p = page(list, a, 20);
      return { structured: { expenses: p.slice.map((x) => Object.assign({}, x, { employee: nameOf(store, x.employee_id), policy_notes: expenseNotes(x) })), total_amount_usd: total, by_status: by, next_cursor: p.next_cursor, total: p.total }, summary: p.total + ' expense(s), $' + total.toFixed(2) + ' in total.', untrusted: p.slice.map((x, i) => ({ path: 'expenses[' + i + '].notes', source: 'expense ' + x.id + ' notes' })) };
    }
  },
  {
    name: 'metrics_query', title: 'Query internal metrics (read-only SQL)', minRole: 'agent',
    description: 'Run one read-only SQLite SELECT over the analytics tables: metrics_daily, deployments, incidents, tickets. Writes, PRAGMA, ATTACH, recursive CTEs and system tables are rejected. Results are capped (default 100 rows). Read the schema://metrics resource for columns.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: 'object', additionalProperties: false, required: ['sql'], properties: { sql: { type: 'string', minLength: 6, maxLength: 4000, description: 'One SELECT (or WITH ... SELECT) statement in SQLite syntax' }, max_rows: { type: 'integer', minimum: 1, maximum: 500, default: 100 } } },
    outputSchema: { type: 'object', required: ['columns', 'rows', 'row_count', 'truncated'], properties: { columns: { type: 'array', items: { type: 'string' } }, rows: { type: 'array', items: { type: 'object' } }, row_count: { type: 'integer' }, truncated: { type: 'boolean' } } },
    run(a, { metrics, store }) {
      if (!metrics) throw new ToolError('The metrics database is not loaded yet.', 'Try again in a moment.', 'UNAVAILABLE');
      metrics.syncTickets(store.tickets, store.version);
      let r;
      try { r = metrics.query(a.sql, a.max_rows || 100); } catch (e) {
        if (e.code === 'SQL_GUARD') throw new ToolError(e.message, 'Write a single SELECT over: ' + Object.keys(METRICS_SCHEMA).concat(['tickets']).join(', ') + '.', 'SQL_GUARD');
        throw new ToolError('SQL error: ' + String(e.message).replace(/^Error:\s*/, ''), 'Check column names in the schema://metrics resource.', 'SQL_ERROR');
      }
      return { structured: r, summary: r.row_count + ' row(s)' + (r.truncated ? ' (truncated; add LIMIT or raise max_rows)' : '') + '.' };
    }
  },
  {
    name: 'audit_recent', title: 'Read the audit log', minRole: 'admin',
    description: 'Most recent audit log entries (who called what, outcome, timing). Arguments in entries are already redacted.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: { type: 'object', additionalProperties: false, properties: { limit: LIMIT(20, 100), outcome: { type: 'string', enum: ['ok', 'dry_run', 'denied', 'rate_limited', 'invalid', 'error'] }, principal: { type: 'string', maxLength: 60 } } },
    outputSchema: { type: 'object', required: ['entries'], properties: { entries: { type: 'array', items: { type: 'object' } } } },
    run(a, { audit }) {
      const entries = audit.list({ limit: a.limit || 20, outcome: a.outcome, principal: a.principal });
      return { structured: { entries }, summary: entries.length + ' audit entr' + (entries.length === 1 ? 'y' : 'ies') + '.' };
    }
  }
];
export const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

function buildTicket(a, { store, principal, now }, dry) {
  const requester = a.requester_id || principal.employee_id;
  if (!requester) throw new ToolError('requester_id is required for this caller (the token is not linked to an employee).', 'Pass requester_id, e.g. E012.', 'MISSING_FIELD');
  needEmployee(store, requester, 'requester_id');
  if (a.assignee_id) needEmployee(store, a.assignee_id, 'assignee_id');
  const ts = new Date(now()).toISOString().replace(/\.\d{3}Z$/, 'Z');
  return { id: store.nextTicketId() + (dry ? ' (preview)' : ''), title: a.title.trim(), body: a.description.trim(), status: 'open', priority: a.priority || 'P3', category: a.category || 'other', requester_id: requester, assignee_id: a.assignee_id || null, created_at: ts, updated_at: ts, created_by: principal.id, comments: [] };
}
function planUpdate(a, { store, principal, now }) {
  const t = needTicket(store, a.id);
  const changes = []; const after = JSON.parse(JSON.stringify(t));
  ['status', 'priority', 'assignee_id'].forEach((f) => { if (a[f] !== undefined && a[f] !== t[f]) { changes.push({ field: f, from: t[f], to: a[f] }); after[f] = a[f]; } });
  if (a.assignee_id) needEmployee(store, a.assignee_id, 'assignee_id');
  if (a.status === 'closed' && t.status !== 'closed' && principal.role !== 'admin') throw new ToolError('Closing a ticket needs the admin role (you are ' + principal.role + ').', 'Set status to "resolved" instead; an admin closes resolved tickets.', 'FORBIDDEN');
  if (a.comment) { const c = { author_id: principal.employee_id || null, author_label: principal.name, at: new Date(now()).toISOString().replace(/\.\d{3}Z$/, 'Z'), text: a.comment.trim() }; after.comments.push(c); changes.push({ field: 'comment', from: null, to: c.text }); }
  if (!changes.length) throw new ToolError('Nothing to change: the ticket already has those values.', 'Pass a different status, priority, assignee_id or a comment.', 'NO_CHANGES');
  after.updated_at = new Date(now()).toISOString().replace(/\.\d{3}Z$/, 'Z');
  return { after, changes };
}
function describeChanges(ch) { return ch.map((c) => (c.field === 'comment' ? 'add comment' : c.field + ' ' + (c.from == null ? '(none)' : c.from) + ' \u2192 ' + c.to)).join(', '); }
