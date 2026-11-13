import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runtime, principal, text, NOW } from './helpers.js';

const call = (rt, role, name, args, emp) => rt.gateway.callTool(principal(role, emp), name, args, { transport: 'test' });

test('every tool runs for a role that may use it', async () => {
  const { rt } = await runtime();
  const cases = {
    directory_search: { query: 'platform' }, directory_get_employee: { id: 'E004' }, wiki_search: { query: 'expense limits' }, wiki_get_page: { slug: 'oncall-handbook' },
    tickets_list: { status: 'active' }, ticket_get: { id: 'IT-1003' }, ticket_create: { title: 'Webcam not detected', description: 'The webcam is not detected in video calls.' },
    ticket_update: { id: 'IT-1003', comment: 'Looking into it.' }, oncall_lookup: {}, asset_lookup: { assigned_to: 'E024' }, expense_lookup: { status: 'submitted' },
    metrics_query: { sql: 'SELECT COUNT(*) AS n FROM incidents' }, audit_recent: { limit: 5 }
  };
  for (const [name, args] of Object.entries(cases)) {
    const r = await call(rt, 'admin', name, args);
    assert.ok(!r.isError, name + ': ' + text(r));
    assert.ok(r.structuredContent, name + ' has structured content');
  }
});
test('directory: search, pagination, profile, salary band only for admin', async () => {
  const { rt } = await runtime();
  const p1 = await call(rt, 'viewer', 'directory_search', { limit: 10 });
  assert.equal(p1.structuredContent.total, 24); assert.equal(p1.structuredContent.employees.length, 10); assert.ok(p1.structuredContent.next_cursor);
  const p3 = await call(rt, 'viewer', 'directory_search', { limit: 10, cursor: 'ok' });
  assert.equal(p3.structuredContent.employees.length, 4);
  assert.equal(p3.structuredContent.next_cursor, null);
  assert.ok(!('phone' in p1.structuredContent.employees[0]));
  const k = await call(rt, 'viewer', 'directory_search', { query: 'kubernetes' }); assert.equal(k.structuredContent.employees[0].name, 'Priya Raman');
  const v = await call(rt, 'viewer', 'directory_get_employee', { email: 'luis.ortega@brightwave.example' });
  assert.equal(v.structuredContent.manager.name, 'Priya Raman'); assert.equal(v.structuredContent.salary_band, undefined); assert.match(text(v), /Salary band hidden/);
  const a = await call(rt, 'admin', 'directory_get_employee', { id: 'E004' }); assert.equal(a.structuredContent.salary_band, 'L5');
  const none = await call(rt, 'viewer', 'directory_get_employee', {}); assert.equal(none.isError, true); assert.match(text(none), /either id or email/);
  const miss = await call(rt, 'viewer', 'directory_get_employee', { id: 'E999' }); assert.match(text(miss), /No employee.*Hint: Use directory_search/s);
  const bad = await call(rt, 'viewer', 'directory_search', { cursor: 'zzz!' }); assert.match(text(bad), /cursor is not valid/);
});
test('wiki search finds the PTO answer and returns resource links', async () => {
  const { rt } = await runtime();
  const r = await call(rt, 'viewer', 'wiki_search', { query: 'how many vacation PTO days do I get' });
  assert.equal(r.structuredContent.results[0].slug, 'pto-policy'); assert.match(r.structuredContent.results[0].snippet, /20 days/);
  assert.ok(r.content.some((c) => c.type === 'resource_link' && c.uri === 'wiki://pages/pto-policy'));
  const w = await call(rt, 'viewer', 'wiki_get_page', { slug: 'remote-work' });
  assert.equal(w.structuredContent.security.injection_flags.length, 1); assert.match(text(w), /<untrusted_data source=\\"wiki page remote-work\\">/);
  const nf = await call(rt, 'viewer', 'wiki_get_page', { slug: 'nope' }); assert.match(text(nf), /Pages: pto-policy/);
});
test('tickets: injection in IT-1007 is fenced and flagged in text, structured content and audit', async () => {
  const { rt } = await runtime();
  const r = await call(rt, 'viewer', 'ticket_get', { id: 'IT-1007' });
  const t = text(r);
  assert.match(t, /⚠ Possible prompt injection in ticket IT-1007 description/);
  assert.match(t, /<untrusted_data source=\\"ticket IT-1007 description\\">\\nThe floor 3 printer/);
  assert.equal(r.structuredContent.security.injection_flags[0].path, 'body');
  assert.equal(r.structuredContent.body.startsWith('The floor 3 printer'), true, 'structured body stays raw for programs');
  const entry = rt.audit.list({ limit: 1 })[0]; assert.equal(entry.flags[0].source, 'ticket IT-1007 description');
  const clean = await call(rt, 'viewer', 'ticket_get', { id: 'IT-1003' }); assert.deepEqual(clean.structuredContent.security.injection_flags, []);
  const list = await call(rt, 'viewer', 'tickets_list', { priority: 'P1', status: 'active' });
  assert.deepEqual(list.structuredContent.tickets.map((x) => x.id).sort(), ['IT-1005', 'IT-1012']);
  const un = await call(rt, 'viewer', 'tickets_list', { unassigned: true }); assert.deepEqual(un.structuredContent.tickets.map((x) => x.id), ['IT-1014', 'IT-1007']);
});
test('write tools: dry run by default, confirm applies, persisted to disk', async () => {
  const { rt, dir } = await runtime();
  const args = { title: 'Laptop fan is loud', description: 'Fan runs at full speed all day.', priority: 'P3', category: 'hardware' };
  const dry = await call(rt, 'agent', 'ticket_create', args);
  assert.equal(dry.structuredContent.dry_run, true); assert.equal(rt.store.tickets.length, 14); assert.match(text(dry), /Dry run: would create IT-1015/);
  const real = await call(rt, 'agent', 'ticket_create', Object.assign({ confirm: true }, args));
  assert.equal(real.structuredContent.dry_run, false); assert.equal(real.structuredContent.ticket.id, 'IT-1015'); assert.equal(real.structuredContent.ticket.requester_id, 'E011');
  assert.equal(real.structuredContent.ticket.created_at, new Date(NOW).toISOString().replace('.000', ''));
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')); assert.equal(saved.tickets.length, 15);
  const up = await call(rt, 'agent', 'ticket_update', { id: 'IT-1015', status: 'in_progress', assignee_id: 'E012' });
  assert.equal(up.structuredContent.dry_run, true); assert.equal(rt.store.ticket('IT-1015').status, 'open');
  const up2 = await call(rt, 'agent', 'ticket_update', { id: 'IT-1015', status: 'in_progress', assignee_id: 'E012', confirm: true });
  assert.deepEqual(up2.structuredContent.changes.map((c) => c.field), ['status', 'assignee_id']); assert.equal(rt.store.ticket('IT-1015').assignee_id, 'E012');
  const same = await call(rt, 'agent', 'ticket_update', { id: 'IT-1015', status: 'in_progress', confirm: true }); assert.match(text(same), /Nothing to change/);
  const close = await call(rt, 'agent', 'ticket_update', { id: 'IT-1015', status: 'closed', confirm: true }); assert.equal(close.isError, true); assert.match(text(close), /needs the admin role.*resolved/s);
  const close2 = await call(rt, 'admin', 'ticket_update', { id: 'IT-1015', status: 'closed', confirm: true }); assert.ok(!close2.isError);
  const noReq = await call(rt, 'agent', 'ticket_create', { title: 'Need a dock', description: 'Need a USB-C dock please.' }, null); assert.match(text(noReq), /requester_id is required/);
  const outcomes = rt.audit.all().filter((e) => e.kind === 'tool').map((e) => e.outcome);
  assert.deepEqual(outcomes, ['dry_run', 'ok', 'dry_run', 'ok', 'error', 'denied', 'ok', 'error']);
});
test('permissions: viewer cannot write, read expenses, query metrics or read the audit log', async () => {
  const { rt } = await runtime();
  for (const [name, args] of [['ticket_create', { title: 'x'.repeat(6), description: 'y'.repeat(12) }], ['ticket_update', { id: 'IT-1003', comment: 'hi' }], ['expense_lookup', {}], ['metrics_query', { sql: 'SELECT 1' }], ['audit_recent', {}]]) {
    const r = await call(rt, 'viewer', name, args);
    assert.equal(r.isError, true, name); assert.match(text(r), new RegExp('Permission denied: ' + name + ' needs the (agent|admin) role'));
  }
  assert.equal(rt.audit.all().filter((e) => e.outcome === 'denied').length, 5);
  const ag = await call(rt, 'agent', 'audit_recent', {}); assert.match(text(ag), /needs the admin role/);
});
test('metrics_query: results, row cap, guard errors, SQL errors, live tickets table', async () => {
  const { rt } = await runtime();
  const r = await call(rt, 'agent', 'metrics_query', { sql: "SELECT service, ROUND(100.0*SUM(errors)/SUM(requests),3) AS error_pct FROM metrics_daily WHERE date = '2026-10-21' GROUP BY service ORDER BY error_pct DESC" });
  assert.equal(r.structuredContent.rows[0].service, 'payments'); assert.ok(r.structuredContent.rows[0].error_pct > 2.5);
  const cap = await call(rt, 'agent', 'metrics_query', { sql: 'SELECT * FROM metrics_daily', max_rows: 7 }); assert.equal(cap.structuredContent.row_count, 7); assert.equal(cap.structuredContent.truncated, true);
  const g = await call(rt, 'agent', 'metrics_query', { sql: 'DROP TABLE metrics_daily' }); assert.equal(g.isError, true); assert.match(text(g), /Only read-only SELECT/);
  const e = await call(rt, 'agent', 'metrics_query', { sql: 'SELECT nope FROM incidents' }); assert.match(text(e), /SQL error: no such column: nope/);
  const before = await call(rt, 'agent', 'metrics_query', { sql: "SELECT COUNT(*) AS n FROM tickets WHERE status='open'" });
  await call(rt, 'agent', 'ticket_create', { title: 'Another issue', description: 'Something else broke today.', confirm: true });
  const after = await call(rt, 'agent', 'metrics_query', { sql: "SELECT COUNT(*) AS n FROM tickets WHERE status='open'" });
  assert.equal(after.structuredContent.rows[0].n, before.structuredContent.rows[0].n + 1);
  const still = await call(rt, 'agent', 'metrics_query', { sql: 'SELECT COUNT(*) AS n FROM metrics_daily' }); assert.equal(still.structuredContent.rows[0].n, 240);
});
test('on-call rotation, assets, expenses with policy notes', async () => {
  const { rt } = await runtime();
  const oc = await call(rt, 'viewer', 'oncall_lookup', { team: 'payments', at: '2026-11-13T12:00:00Z' });
  assert.equal(oc.structuredContent.shifts[0].primary.name, 'Tomás Rivera'); assert.equal(oc.structuredContent.shifts[0].secondary.name, 'Grace Liu'); assert.equal(oc.structuredContent.shifts[0].shift_start, '2026-11-09T15:00:00.000Z');
  const next = await call(rt, 'viewer', 'oncall_lookup', { team: 'payments', at: '2026-11-16T16:00:00Z' }); assert.equal(next.structuredContent.shifts[0].primary.name, 'Grace Liu');
  const all = await call(rt, 'viewer', 'oncall_lookup', {}); assert.equal(all.structuredContent.shifts.length, 4);
  const as = await call(rt, 'viewer', 'asset_lookup', { tag: 'LT-0007' }); assert.equal(as.structuredContent.assets[0].assigned_to_name, 'Mei Tanaka');
  const nf = await call(rt, 'viewer', 'asset_lookup', { tag: 'LT-9999' }); assert.match(text(nf), /No asset with tag/);
  const w = await call(rt, 'viewer', 'asset_lookup', { warranty_expires_before: '2026-11-13', status: 'in_use' }); assert.ok(w.structuredContent.assets.some((x) => x.tag === 'PR-0003'));
  const ex = await call(rt, 'agent', 'expense_lookup', { status: 'submitted', min_amount: 500 });
  assert.deepEqual(ex.structuredContent.expenses.map((x) => x.id).sort(), ['EX-2005', 'EX-2009', 'EX-2010', 'EX-2018']);
  assert.ok(ex.structuredContent.expenses.find((x) => x.id === 'EX-2009').policy_notes[0].includes('VP approval'));
  const oncallMeal = await call(rt, 'agent', 'expense_lookup', { employee_id: 'E008' }); assert.ok(oncallMeal.structuredContent.expenses[0].policy_notes.some((n) => /\$40/.test(n)));
  const range = await call(rt, 'agent', 'expense_lookup', { from: '2026-12-01', to: '2026-11-01' }); assert.match(text(range), /after "to"/);
});
test('rate limit: write bucket trips and is audited', async () => {
  const { rt } = await runtime({ cfg: { rateLimits: { perMinute: 100, writesPerMinute: 2 } } });
  const args = { title: 'Test rate limit', description: 'Testing the write limit.' };
  await call(rt, 'agent', 'ticket_create', args); await call(rt, 'agent', 'ticket_create', args);
  const r = await call(rt, 'agent', 'ticket_create', args);
  assert.equal(r.isError, true); assert.match(text(r), /Rate limit reached \(2 write calls per minute\)/);
  assert.equal(rt.audit.list({ limit: 1 })[0].outcome, 'rate_limited');
});
test('audit log is JSONL on disk, redacted, with no secrets', async () => {
  const { rt, cfg } = await runtime();
  await call(rt, 'agent', 'ticket_create', { title: 'Password reset for luis.ortega@brightwave.example', description: 'My password is hunter2-secret and phone +1-512-555-0103', confirm: true });
  const lines = fs.readFileSync(cfg.auditFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const e = lines[lines.length - 1];
  assert.equal(e.name, 'ticket_create'); assert.equal(e.outcome, 'ok'); assert.equal(e.write, 'applied'); assert.equal(e.principal, 'test:agent');
  assert.match(e.args.title, /l\*\*\*@brightwave\.example/); assert.match(e.args.description, /\*\*\*-0103/);
  assert.ok(typeof e.duration_ms === 'number' && e.ts.endsWith('Z'));
  assert.equal(fs.statSync(cfg.auditFile).mode & 0o777, 0o600);
});
