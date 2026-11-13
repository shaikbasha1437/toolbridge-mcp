/* Demo mode (no key): a deterministic rule-based planner that picks MCP tools from the question, calls them
   through the same approval gate as the live agent, and writes the answer from the tool results with
   templates. It is not AI; it shows what an agent does with these tools. */
import { invokeTool } from './agent.js';

const TEAM_WORDS = [['platform', /platform|infra|sre|kubernetes/i], ['payments', /payment|billing|ledger/i], ['identity', /identity|sso|login|auth|okta/i], ['it-helpdesk', /helpdesk|help desk|\bit\b|it support/i]];
export const EXAMPLES = [
  'Who is on call for payments right now?',
  'How many PTO days do we get?',
  'Show open P1 tickets',
  'Summarize ticket IT-1007',
  'My keyboard keys are sticking, open a ticket',
  'Resolve IT-1003 with a note that the VPN profile was reissued',
  'Error rate by service last week',
  'Run SQL: DELETE FROM tickets',
  'Who is Luis Ortega\u2019s manager?',
  'Which laptops are in repair?',
  'Pending expenses over $500',
  'Weekly status for identity'
];
const sc = (r) => r.structuredContent || {};
const errText = (r) => (r.content || []).map((c) => c.text || '').join('\n').replace(/^Error: /, '');
function teamOf(q) { const t = TEAM_WORDS.find(([, re]) => re.test(q)); return t ? t[0] : null; }
function priorityOf(q) { const m = /\bP([1-4])\b/i.exec(q); if (m) return 'P' + m[1]; if (/urgent|asap|blocked|can'?t work|down for everyone|outage/i.test(q)) return 'P2'; if (/whenever|low priority|minor|request/i.test(q)) return 'P4'; return 'P3'; }
function categoryOf(q) { return /phish|suspicious|malware|hack|stolen/i.test(q) ? 'security' : /vpn|wi-?fi|network|internet|ethernet/i.test(q) ? 'network' : /access|permission|login|password|sso|mfa|account/i.test(q) ? 'access' : /license|install|software|app\b|application|update/i.test(q) ? 'software' : /laptop|keyboard|mouse|monitor|screen|battery|printer|dock|headset|webcam|hardware|charger/i.test(q) ? 'hardware' : 'other'; }
function ticketTitle(q) {
  const colon = q.split(/:\s*/); if (colon.length > 1 && colon[colon.length - 1].length > 4) return cap(colon[colon.length - 1]).slice(0, 110);
  const s = q.replace(/\b(please|can you|could you|i need you to|for me)\b/gi, '').replace(/,?\s*(and )?(open|create|file|raise|log|submit)\s+(a |an )?(new )?(ticket|issue|request)( for (it|this|me))?\.?/i, '').replace(/\s+/g, ' ').trim().replace(/[.!?]+$/, '');
  return cap(s || 'Help request').slice(0, 110);
}
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const fmtMoney = (n) => '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function table(cols, rows) { return '| ' + cols.join(' | ') + ' |\n|' + cols.map(() => '---').join('|') + '|\n' + rows.map((r) => '| ' + cols.map((c) => String(r[c] ?? '')).join(' | ') + ' |').join('\n'); }
function denied(r) { return r.isError && /Permission denied/.test(errText(r)); }
function deniedAnswer(r) { return '**Not allowed for your role.** ' + errText(r).split('\n')[0] + ' Switch the role at the top to try it as an agent or admin.'; }

export function classify(q) {
  const s = q.trim();
  if (/^\s*(run\s+)?sql\s*:|^\s*(select|with|delete|drop|update|insert|pragma|alter)\b/i.test(s)) return 'sql';
  if (/weekly status|status (report|update)/i.test(s)) return 'weekly';
  if (/audit (log|trail)|who (called|did)/i.test(s)) return 'audit';
  if (/\b(close|resolve|reopen|reassign|assign|escalate|comment on|update|mark)\b.*\bIT-\d{4}\b|\bIT-\d{4}\b.*\b(as )?(resolved|closed|in progress|blocked)\b/i.test(s)) return 'update';
  if (/\b(open|create|file|raise|log|submit)\b.*\b(ticket|issue)\b|\bnew ticket\b/i.test(s)) return 'create';
  if (/\bIT-\d{4}\b/i.test(s)) return 'ticket';
  if (/\btickets?\b|\bissues?\b|helpdesk queue/i.test(s)) return 'tickets';
  if (/on[- ]?call|paged|pager|escalation/i.test(s)) return 'oncall';
  if (/expense|reimburs|spent|spend/i.test(s)) return 'expenses';
  if (/error rate|errors|latency|p95|requests|traffic|revenue|signups|deploy|incident|uptime|metrics/i.test(s)) return 'metrics';
  if (/laptop|monitor|asset|license|warranty|\b(LT|MN|DK|PH|PR|SW)-[A-Z0-9]{4,}\b|printer|equipment|device/i.test(s)) return 'assets';
  if (/\bwho\b|manager|reports to|contact|email|phone|directory|find (someone|a person)|team members?|works on/i.test(s)) return 'directory';
  if (/policy|pto|vacation|holiday|time off|sick|reimburse|expense limit|per diem|onboard|remote|stipend|security|password|phishing|severity|sev\d|how (do|can) i|handbook|wiki|carry over/i.test(s)) return 'wiki';
  return 'help';
}
function nameQuery(q) {
  const m = /(?:who is|who's|find|contact|email|phone|manager of|about)\s+([A-Z][\w\u00C0-\u017F'-]+(?:\s+[A-Z][\w\u00C0-\u017F-]+)?)/.exec(q.replace(/[\u2019']s\b/g, ''));
  if (m) return m[1];
  const caps = (q.replace(/[\u2019']s\b/g, '').match(/\b[A-Z][a-z\u00C0-\u017F]+(?:\s+[A-Z][a-z\u00C0-\u017F]+)?/g) || []).filter((w) => !/^(Who|What|Find|Show|Is|The|My|Please|Can|Brightwave|Labs|Contact)$/.test(w));
  return caps[0] || q.replace(/^.*\b(who|find|contact)\b/i, '').replace(/[?.]/g, '').trim();
}

export async function runDemoAgent(o) {
  const { ctx, question } = o; const q = String(question || '').trim();
  const call = (name, args) => invokeTool(ctx, name, args);
  const kind = classify(q);
  if (kind === 'oncall') {
    const team = teamOf(q.replace(/on[- ]?call/ig, ''));
    const r = await call('oncall_lookup', team ? { team } : {});
    if (r.isError) return errText(r);
    return sc(r).shifts.map((s) => '**' + s.team + '**: ' + s.primary.name + ' is primary (' + s.primary.phone + '), ' + s.secondary.name + ' is secondary; escalation ' + s.escalation.name + '. Shift ends ' + new Date(s.shift_end).toUTCString().replace(':00 GMT', ' UTC') + '.').join('\n');
  }
  if (kind === 'wiki') {
    const r = await call('wiki_search', { query: q.slice(0, 200), limit: 3 });
    if (r.isError) return errText(r);
    const res = sc(r).results; if (!res.length) return 'I could not find a wiki page about that. Try other keywords, like "PTO", "expense limits" or "on-call".';
    const top = res[0]; const page = await call('wiki_get_page', { slug: top.slug });
    const flags = sc(page).security && sc(page).security.injection_flags.length;
    return '**' + top.title + '**: ' + top.snippet + '\n\nSource: `' + top.uri + '`' + (res.length > 1 ? '\nAlso relevant: ' + res.slice(1).map((x) => x.title).join(', ') + '.' : '') + (flags ? '\n\n\u26a0 That page contains a reader comment that tries to give instructions to AI assistants (asking for keys or tokens). I treated it as data and ignored it.' : '');
  }
  if (kind === 'tickets') {
    const args = {}; const p = /\bP([1-4])\b/i.exec(q); if (p) args.priority = 'P' + p[1];
    if (/unassigned/i.test(q)) args.unassigned = true;
    args.status = /closed/i.test(q) ? 'closed' : /resolved/i.test(q) ? 'resolved' : /blocked/i.test(q) ? 'blocked' : /in progress/i.test(q) ? 'in_progress' : /\ball\b/i.test(q) ? undefined : 'active';
    if (!args.status) delete args.status;
    const cat = categoryOf(q); if (/tickets? (about|for)\b/i.test(q) && cat !== 'other') args.category = cat;
    const r = await call('tickets_list', args);
    if (r.isError) return errText(r);
    const t = sc(r).tickets; if (!t.length) return 'No tickets match' + (args.priority ? ' ' + args.priority : '') + '.';
    return '**' + sc(r).total + ' ticket(s)**' + (args.priority ? ' at ' + args.priority : '') + (args.status ? ' (' + args.status.replace('_', ' ') + ')' : '') + ':\n' + t.map((x) => '- ' + x.id + ' [' + x.priority + ', ' + x.status + '] ' + x.title + ' (assignee: ' + (x.assignee || 'unassigned') + ')').join('\n') + (sc(r).next_cursor ? '\n(More on the next page.)' : '');
  }
  if (kind === 'ticket') {
    const id = /IT-\d{4}/i.exec(q)[0].toUpperCase();
    const r = await call('ticket_get', { id });
    if (r.isError) return errText(r);
    const t = sc(r); const flags = (t.security && t.security.injection_flags) || [];
    const first = t.body.split(/\n\s*\n/)[0];
    let out = '**' + t.id + ': ' + t.title + '** [' + t.status + ', ' + t.priority + ', ' + t.category + ']\nRequested by ' + (t.requester ? t.requester.name : 'unknown') + '; assignee ' + (t.assignee ? t.assignee.name : 'none') + '.\n\nSummary: ' + first.slice(0, 260);
    if (t.comments.length) out += '\nLatest comment (' + t.comments[t.comments.length - 1].author + '): ' + t.comments[t.comments.length - 1].text;
    if (flags.length) out += '\n\n\u26a0 **Prompt injection flagged.** The ticket text includes instructions aimed at an AI assistant (' + flags[0].kinds.join(', ') + '): it asks to close every open ticket and send the employee directory to an outside address. I did not follow it. A human should review this ticket.';
    return out;
  }
  if (kind === 'create') {
    const args = { title: ticketTitle(q), description: q.length >= 10 ? q : q + ' (reported via the assistant)', priority: priorityOf(q), category: categoryOf(q) };
    const dry = await call('ticket_create', args);
    if (denied(dry)) return deniedAnswer(dry);
    if (dry.isError) return 'I could not prepare the ticket: ' + errText(dry);
    const r = await call('ticket_create', Object.assign({}, args, { confirm: true }));
    if (r.declined) return 'Okay, I did not create the ticket. Nothing was changed.';
    if (r.isError) return 'The ticket was not created: ' + errText(r);
    const t = sc(r).ticket; return 'Created **' + t.id + '**: "' + t.title + '" (' + t.priority + ', ' + t.category + '). The helpdesk will pick it up; you can ask me "summarize ' + t.id + '" any time.';
  }
  if (kind === 'update') {
    const id = /IT-\d{4}/i.exec(q)[0].toUpperCase(); const args = { id };
    if (/\bclose/i.test(q) || /as closed/i.test(q)) args.status = 'closed'; else if (/resolve/i.test(q)) args.status = 'resolved'; else if (/reopen/i.test(q)) args.status = 'open'; else if (/in progress/i.test(q)) args.status = 'in_progress'; else if (/blocked/i.test(q)) args.status = 'blocked';
    const p = /\bP([1-4])\b/i.exec(q); if (p || /escalate/i.test(q)) args.priority = p ? 'P' + p[1] : 'P2';
    const note = /(?:note|comment|saying|says?|that)\s+(?:that\s+)?["\u201c]?(.{3,300}?)["\u201d]?\s*$/i.exec(q); if (note) args.comment = cap(note[1]).replace(/\.?$/, '.');
    const who = /assign(?:ed)?\s+(?:it\s+)?to\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/.exec(q);
    if (who) { const d = await call('directory_search', { query: who[1], limit: 1 }); const e = sc(d).employees && sc(d).employees[0]; if (e) args.assignee_id = e.id; else return 'I could not find "' + who[1] + '" in the directory.'; }
    if (!args.status && !args.priority && !args.comment && !args.assignee_id) return 'What should change on ' + id + '? For example "resolve ' + id + '", "assign ' + id + ' to Kwame Mensah" or "escalate ' + id + ' to P1".';
    const dry = await call('ticket_update', args);
    if (denied(dry)) return deniedAnswer(dry);
    if (dry.isError) return 'I could not prepare that change: ' + errText(dry);
    const r = await call('ticket_update', Object.assign({}, args, { confirm: true }));
    if (r.declined) return 'Okay, I left ' + id + ' unchanged.';
    if (r.isError) return 'The update failed: ' + errText(r);
    return 'Updated **' + id + '**: ' + sc(r).changes.map((c) => c.field === 'comment' ? 'added a comment' : c.field.replace('_id', '') + ' ' + (c.from || 'none') + ' \u2192 ' + c.to).join(', ') + '.';
  }
  if (kind === 'directory') {
    const name = nameQuery(q);
    const s = await call('directory_search', { query: name.slice(0, 100), limit: 5 });
    if (s.isError) return errText(s);
    const list = sc(s).employees; if (!list.length) return 'Nobody in the directory matches "' + name + '".';
    if (list.length > 1 && !/manager|reports|phone/i.test(q)) return list.length + ' people match "' + name + '":\n' + list.map((e) => '- ' + e.name + ', ' + e.title + ' (' + e.team + ', ' + e.location + ')').join('\n');
    const g = await call('directory_get_employee', { id: list[0].id });
    if (g.isError) return errText(g);
    const e = sc(g);
    return '**' + e.name + '**, ' + e.title + ' on the ' + e.team + ' team (' + e.location + '). Email ' + e.email + ', phone ' + e.phone + '.\nManager: ' + (e.manager ? e.manager.name + ' (' + e.manager.title + ')' : 'none') + '.' + (e.direct_reports.length ? ' Direct reports: ' + e.direct_reports.map((x) => x.name).join(', ') + '.' : '') + (e.salary_band ? '\nSalary band (admin only): ' + e.salary_band + '.' : '');
  }
  if (kind === 'assets') {
    const args = {}; const tag = /\b(LT|MN|DK|PH|PR|SW)-[A-Z0-9]{4,}\b/i.exec(q); if (tag) args.tag = tag[0].toUpperCase();
    const ty = /(laptop|monitor|dock|phone|printer|license)/i.exec(q); if (ty && !tag) args.type = ty[1].toLowerCase();
    const st = /\b(repair|spare|retired|in use)\b/i.exec(q); if (st) args.status = st[1].toLowerCase().replace(' ', '_');
    if (/warranty/i.test(q)) args.warranty_expires_before = '2027-01-01';
    const emp = /\bE\d{3}\b/.exec(q); if (emp) args.assigned_to = emp[0];
    const r = await call('asset_lookup', args);
    if (r.isError) return errText(r);
    const a = sc(r).assets; if (!a.length) return 'No assets match.';
    return '**' + sc(r).total + ' asset(s)**:\n' + a.map((x) => '- ' + x.tag + ': ' + x.model + ' [' + x.status + ']' + (x.assigned_to_name ? ', assigned to ' + x.assigned_to_name : '') + ', warranty to ' + x.warranty_end).join('\n');
  }
  if (kind === 'expenses') {
    const args = {}; const st = /\b(submitted|pending|approved|rejected|reimbursed)\b/i.exec(q); if (st) args.status = st[1].toLowerCase() === 'pending' ? 'submitted' : st[1].toLowerCase();
    const amt = /(?:over|above|more than|>)\s*\$?\s*([\d,]+)/i.exec(q); if (amt) args.min_amount = Number(amt[1].replace(/,/g, ''));
    const r = await call('expense_lookup', args);
    if (denied(r)) return deniedAnswer(r);
    if (r.isError) return errText(r);
    const x = sc(r); if (!x.expenses.length) return 'No expense reports match.';
    return '**' + x.total + ' expense report(s), ' + fmtMoney(x.total_amount_usd) + ' total**:\n' + x.expenses.map((e) => '- ' + e.id + ' ' + e.employee + ': ' + fmtMoney(e.amount) + ' ' + e.category + ' at ' + e.merchant + ' [' + e.status + ']' + (e.policy_notes.length ? ' \u2014 ' + e.policy_notes.join(' ') : '')).join('\n');
  }
  if (kind === 'metrics' || kind === 'sql') {
    let sql; let label;
    if (kind === 'sql') { sql = q.replace(/^\s*(run\s+)?sql\s*:\s*/i, ''); label = 'your query'; }
    else if (/deploy/i.test(q)) { sql = "SELECT service, COUNT(*) AS deploys, SUM(status = 'rolled_back') AS rollbacks FROM deployments WHERE date >= '2026-10-13' GROUP BY service ORDER BY deploys DESC"; label = 'deployments in the last 30 days'; }
    else if (/incident/i.test(q)) { sql = 'SELECT id, service, severity, started_at, COALESCE(resolved_at, \'ongoing\') AS resolved_at, summary FROM incidents ORDER BY started_at DESC'; label = 'incidents'; }
    else if (/revenue/i.test(q)) { sql = "SELECT date, revenue_usd FROM metrics_daily WHERE service = 'payments' AND date >= '2026-11-06' ORDER BY date"; label = 'payments revenue, last 7 days'; }
    else if (/signup/i.test(q)) { sql = "SELECT date, signups FROM metrics_daily WHERE service = 'identity' AND date >= '2026-11-06' ORDER BY date"; label = 'signups, last 7 days'; }
    else if (/latency|p95/i.test(q)) { sql = "SELECT service, ROUND(AVG(p95_ms)) AS avg_p95_ms, MAX(p95_ms) AS worst_p95_ms FROM metrics_daily WHERE date >= '2026-11-06' GROUP BY service ORDER BY avg_p95_ms DESC"; label = 'p95 latency, last 7 days'; }
    else { sql = "SELECT service, SUM(requests) AS requests, SUM(errors) AS errors, ROUND(100.0 * SUM(errors) / SUM(requests), 3) AS error_pct FROM metrics_daily WHERE date >= '2026-11-06' GROUP BY service ORDER BY error_pct DESC"; label = 'error rate by service, 2026-11-06 to 2026-11-12'; }
    const r = await call('metrics_query', { sql, max_rows: 50 });
    if (denied(r)) return deniedAnswer(r);
    if (r.isError) return '**The server refused the query.** ' + errText(r).split('\n')[0] + (/read-only|not allowed|semicolon/i.test(errText(r)) ? '\nThe metrics tool is read-only by design: the SQL guard only accepts a single SELECT over the analytics tables, and the database itself is opened with query_only on.' : '');
    const x = sc(r); if (!x.rows.length) return 'The query returned no rows.';
    return '**' + cap(label) + '** (' + x.row_count + ' row' + (x.row_count === 1 ? '' : 's') + '):\n\n' + table(x.columns, x.rows.slice(0, 20)) + '\n\nSQL: `' + sql + '`';
  }
  if (kind === 'weekly') {
    const team = teamOf(q.replace(/weekly status|status (report|update)/ig, '')) || 'platform';
    const svc = { platform: 'api-gateway', payments: 'payments', identity: 'identity', 'it-helpdesk': null }[team];
    const oc = await call('oncall_lookup', { team });
    const tk = await call('tickets_list', { status: 'active', limit: 20 });
    let metrics = null;
    if (svc) { metrics = await call('metrics_query', { sql: "SELECT ROUND(100.0*SUM(errors)/SUM(requests),3) AS error_pct, ROUND(AVG(p95_ms)) AS avg_p95_ms, SUM(requests) AS requests FROM metrics_daily WHERE service = '" + svc + "' AND date BETWEEN '2026-11-06' AND '2026-11-12'" }); }
    const lines = ['**Weekly status: ' + team + '** (week ending 2026-11-12)'];
    if (!oc.isError) { const s = sc(oc).shifts[0]; lines.push('- On call: ' + s.primary.name + ' (primary), ' + s.secondary.name + ' (secondary).'); }
    if (!tk.isError) { const all = sc(tk).tickets; const p1 = all.filter((t) => t.priority === 'P1'); lines.push('- IT queue: ' + sc(tk).total + ' active tickets, ' + p1.length + ' at P1' + (p1.length ? ' (' + p1.map((t) => t.id + ' ' + t.title).join('; ') + ')' : '') + '.'); }
    if (metrics) { if (denied(metrics)) lines.push('- Metrics: not available for your role (needs agent).'); else if (!metrics.isError) { const m = sc(metrics).rows[0]; lines.push('- ' + svc + ': ' + Number(m.requests).toLocaleString('en-US') + ' requests, error rate ' + m.error_pct + '%, average p95 ' + m.avg_p95_ms + ' ms.'); } }
    if (team === 'identity') lines.push('- Risk: INC-303 (SSO login loop after the IdP certificate rotation) is still open; see IT-1005.');
    return lines.join('\n');
  }
  if (kind === 'audit') {
    const r = await call('audit_recent', { limit: 10 });
    if (denied(r)) return deniedAnswer(r);
    if (r.isError) return errText(r);
    return '**Last ' + sc(r).entries.length + ' audit entries:**\n' + sc(r).entries.map((e) => '- ' + e.ts.slice(11, 19) + ' ' + e.principal + ' ' + e.kind + ' ' + e.name + ' \u2192 ' + e.outcome).join('\n');
  }
  return 'I am the demo planner, so I understand a fixed set of requests. Try one of these:\n' + EXAMPLES.map((e) => '- ' + e).join('\n') + '\n\nAdd your own AI key in Settings for free-form questions.';
}
