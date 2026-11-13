/* STUB, untested against a real ServiceNow instance. Table API: /api/now/table/incident. Auth: basic user +
   password from an env var (OAuth is the better choice in production; not implemented). */
import { httpJson, secretFrom } from './index.js';
const PRI = { P1: '1', P2: '2', P3: '3', P4: '4' };
const STATE = { open: '1', in_progress: '2', blocked: '3', resolved: '6', closed: '7' }; const STATE_BACK = { 1: 'open', 2: 'in_progress', 3: 'blocked', 6: 'resolved', 7: 'closed', 8: 'closed' };
export const servicenowAdapter = {
  group: 'tickets', label: 'ServiceNow', status: 'stub-untested',
  async create(c, deps) {
    const base = String(c.instanceUrl || '').replace(/\/+$/, ''); if (!/^https:\/\/[\w-]+\.service-now\.com$/.test(base) && !c.allowCustomHost) throw new Error('servicenow.instanceUrl must look like https://<instance>.service-now.com');
    const auth = () => 'Basic ' + Buffer.from((c.username || '') + ':' + secretFrom(c, 'password', deps.env)).toString('base64');
    const req = (p, init) => httpJson(deps.fetch, base + p, Object.assign({ headers: { authorization: auth(), accept: 'application/json', 'content-type': 'application/json' } }, init), 'ServiceNow');
    const map = (r) => ({ id: r.number, title: r.short_description, status: STATE_BACK[r.state] || 'open', priority: 'P' + (r.priority || '3'), category: r.category || 'other', requester: (r.caller_id && r.caller_id.display_value) || null, assignee: (r.assigned_to && r.assigned_to.display_value) || null, updated_at: r.sys_updated_on });
    const sysId = async (number) => { const j = await req('/api/now/table/incident?' + new URLSearchParams({ sysparm_query: 'number=' + number, sysparm_fields: 'sys_id', sysparm_limit: '1' })); if (!j.result || !j.result[0]) throw new Error('No ServiceNow incident ' + number); return j.result[0].sys_id; };
    return {
      ticketIdPattern: '^INC\\d{7}$',
      overrides: {
        tickets_list: { async run(a) {
          const off = a.cursor ? parseInt(a.cursor, 10) || 0 : 0; const q = ['ORDERBYDESCsys_created_on'].concat(a.status === 'active' ? ['stateIN1,2,3'] : a.status ? ['state=' + STATE[a.status]] : [], a.priority ? ['priority=' + PRI[a.priority]] : []).join('^');
          const j = await req('/api/now/table/incident?' + new URLSearchParams({ sysparm_query: q, sysparm_limit: String(a.limit || 10), sysparm_offset: String(off), sysparm_display_value: 'true', sysparm_fields: 'number,short_description,state,priority,category,caller_id,assigned_to,sys_updated_on' }));
          const tickets = (j.result || []).map(map);
          return { structured: { tickets, next_cursor: tickets.length === (a.limit || 10) ? String(off + tickets.length) : null, total: tickets.length }, summary: tickets.length + ' ServiceNow incident(s).', untrusted: tickets.map((t, i) => ({ path: 'tickets[' + i + '].title', source: 'ServiceNow ' + t.id })) };
        } },
        ticket_get: { async run(a) {
          const j = await req('/api/now/table/incident?' + new URLSearchParams({ sysparm_query: 'number=' + a.id, sysparm_limit: '1', sysparm_display_value: 'true' }));
          const r = (j.result || [])[0]; if (!r) throw new Error('No ServiceNow incident ' + a.id);
          const out = Object.assign(map(r), { body: r.description || '', created_at: r.sys_created_on, comments: [] }); out.requester = out.requester ? { name: out.requester } : null; out.assignee = out.assignee ? { name: out.assignee } : null;
          return { structured: out, summary: out.id + ' [' + out.status + ']', untrusted: [{ path: 'title', source: 'ServiceNow ' + out.id + ' short description' }, { path: 'body', source: 'ServiceNow ' + out.id + ' description' }] };
        } },
        ticket_create: {
          preview(a) { return { structured: { dry_run: true, ticket: { request: { method: 'POST', url: base + '/api/now/table/incident', body: { short_description: a.title, description: a.description, urgency: PRI[a.priority || 'P3'], category: a.category || 'other' } } }, next_step: 'Nothing was sent to ServiceNow.' }, summary: 'Dry run: would create a ServiceNow incident.' }; },
          async run(a) { const j = await req('/api/now/table/incident', { method: 'POST', body: JSON.stringify({ short_description: a.title, description: a.description, urgency: PRI[a.priority || 'P3'], category: a.category || 'other' }) }); return { structured: { dry_run: false, ticket: { id: j.result.number, title: a.title } }, summary: 'Created ' + j.result.number + '.' }; }
        },
        ticket_update: { async run(a) {
          const body = {}; const changes = [];
          if (a.status) { body.state = STATE[a.status]; changes.push({ field: 'status', from: null, to: a.status }); }
          if (a.priority) { body.urgency = PRI[a.priority]; changes.push({ field: 'priority', from: null, to: a.priority }); }
          if (a.comment) { body.comments = a.comment; changes.push({ field: 'comment', from: null, to: a.comment }); }
          await req('/api/now/table/incident/' + (await sysId(a.id)), { method: 'PATCH', body: JSON.stringify(body) });
          return { structured: { dry_run: false, ticket: { id: a.id }, changes }, summary: 'Updated ' + a.id + '.' };
        } }
      }
    };
  }
};
