import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { tmpDir, text } from './helpers.js';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'toolbridge-mcp.js');
async function connect(mode, extraArgs, env) {
  const dir = tmpDir();
  const c = new Client({ name: 'toolbridge-test', version: '1.0.0' }, { versionNegotiation: { mode } });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [BIN, 'stdio', '--data-dir', dir].concat(extraArgs || []), env: Object.assign({ PATH: process.env.PATH, HOME: dir }, env || {}), stderr: 'pipe' }));
  return { c, dir };
}

for (const mode of ['legacy', 'auto']) {
  test('stdio (' + mode + ' negotiation): discovery of tools, resources, templates and prompts', async () => {
    const { c } = await connect(mode);
    try {
      assert.equal(c.getProtocolEra(), mode === 'auto' ? 'modern' : 'legacy');
      assert.equal(c.getServerVersion().name, 'toolbridge-mcp');
      assert.match(c.getInstructions(), /dry runs unless confirm=true/);
      const { tools } = await c.listTools();
      assert.equal(tools.length, 13);
      const create = tools.find((t) => t.name === 'ticket_create');
      assert.deepEqual(create.annotations, { title: 'Create an IT ticket', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
      assert.equal(create.inputSchema.properties.confirm.type, 'boolean'); assert.ok(create.outputSchema.properties.dry_run);
      assert.equal(tools.find((t) => t.name === 'ticket_update').annotations.destructiveHint, true);
      assert.ok(tools.every((t) => t.outputSchema && t.annotations && t.title));
      const { resources } = await c.listResources();
      const uris = resources.map((r) => r.uri);
      for (const u of ['schema://metrics', 'toolbridge://policy', 'directory://org-chart', 'wiki://pages/pto-policy', 'tickets://IT-1007']) assert.ok(uris.includes(u), u);
      const { resourceTemplates } = await c.listResourceTemplates();
      assert.deepEqual(resourceTemplates.map((t) => t.uriTemplate).sort(), ['tickets://{id}', 'wiki://pages/{slug}']);
      const { prompts } = await c.listPrompts();
      assert.deepEqual(prompts.map((p) => p.name).sort(), ['onboarding_plan', 'triage_ticket', 'weekly_status']);
      const pol = JSON.parse((await c.readResource({ uri: 'toolbridge://policy' })).contents[0].text);
      assert.equal(pol.tools.find((t) => t.name === 'audit_recent').allowed_for_you, false);
      const tk = await c.readResource({ uri: 'tickets://IT-1007' }); assert.match(tk.contents[0].text, /Possible prompt injection detected/);
      const pr = await c.getPrompt({ name: 'triage_ticket', arguments: { ticket_id: 'IT-1007' } });
      assert.equal(pr.messages[1].content.type, 'resource'); assert.match(pr.messages[1].content.resource.text, /<untrusted_data/);
      await assert.rejects(() => c.readResource({ uri: 'tickets://IT-0001' }));
      await assert.rejects(() => c.getPrompt({ name: 'weekly_status', arguments: { team: 'marketing' } }));
    } finally { await c.close(); }
  });
}
test('stdio: call every tool as agent; dry run vs confirm; audit file entries', async () => {
  const { c, dir } = await connect('legacy');
  try {
    const calls = [['directory_search', { query: 'Priya' }], ['directory_get_employee', { id: 'E003' }], ['wiki_search', { query: 'on-call dinner limit' }], ['wiki_get_page', { slug: 'expense-policy' }], ['tickets_list', { status: 'active', limit: 3 }], ['ticket_get', { id: 'IT-1005' }], ['oncall_lookup', { team: 'identity' }], ['asset_lookup', { type: 'license' }], ['expense_lookup', { employee_id: 'E019' }], ['metrics_query', { sql: 'SELECT severity, COUNT(*) n FROM incidents GROUP BY severity' }]];
    for (const [name, args] of calls) { const r = await c.callTool({ name, arguments: args }); assert.ok(!r.isError, name + ': ' + text(r)); assert.ok(r.structuredContent, name); }
    const dry = await c.callTool({ name: 'ticket_create', arguments: { title: 'Badge reader broken', description: 'Front door badge reader is offline.', category: 'hardware' } });
    assert.equal(dry.structuredContent.dry_run, true);
    const listed = await c.callTool({ name: 'tickets_list', arguments: { query: 'badge' } }); assert.equal(listed.structuredContent.total, 0);
    const real = await c.callTool({ name: 'ticket_create', arguments: { title: 'Badge reader broken', description: 'Front door badge reader is offline.', category: 'hardware', confirm: true } });
    assert.equal(real.structuredContent.ticket.id, 'IT-1015');
    const listed2 = await c.callTool({ name: 'tickets_list', arguments: { query: 'badge' } }); assert.equal(listed2.structuredContent.total, 1);
    const upd = await c.callTool({ name: 'ticket_update', arguments: { id: 'IT-1015', status: 'resolved', comment: 'Rebooted the reader.', confirm: true } });
    assert.deepEqual(upd.structuredContent.changes.map((x) => x.field), ['status', 'comment']);
    const denied = await c.callTool({ name: 'audit_recent', arguments: {} }); assert.equal(denied.isError, true);
    const invalid = await c.callTool({ name: 'ticket_get', arguments: { id: 'bad' } }); assert.equal(invalid.isError, true); assert.match(text(invalid), /must match/);
    const lines = fs.readFileSync(path.join(dir, 'audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const tools = lines.filter((l) => l.kind === 'tool');
    assert.equal(tools.length, 17);
    assert.deepEqual(tools.slice(-6).map((l) => l.name + ':' + l.outcome), ['tickets_list:ok', 'ticket_create:ok', 'tickets_list:ok', 'ticket_update:ok', 'audit_recent:denied', 'ticket_get:invalid']);
    assert.equal(tools.find((l) => l.name === 'ticket_create').outcome, 'dry_run');
    assert.ok(lines.every((l) => l.principal === 'stdio:local-stdio' && l.transport === 'stdio'));
  } finally { await c.close(); }
});
test('stdio with --role viewer: writes are denied, reads work', async () => {
  const { c } = await connect('legacy', ['--role', 'viewer']);
  try {
    const r = await c.callTool({ name: 'ticket_create', arguments: { title: 'Viewer attempt', description: 'Viewer should be denied.', confirm: true } });
    assert.equal(r.isError, true); assert.match(text(r), /Permission denied: ticket_create needs the agent role, and this connection has the viewer role/);
    const ok = await c.callTool({ name: 'oncall_lookup', arguments: { team: 'platform' } }); assert.ok(!ok.isError);
  } finally { await c.close(); }
});
test('stdio: ticket state persists across server restarts in the data dir', async () => {
  const first = await connect('legacy');
  await first.c.callTool({ name: 'ticket_create', arguments: { title: 'Persist me please', description: 'This should survive a restart.', confirm: true } });
  await first.c.close();
  const c = new Client({ name: 't', version: '1' });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [BIN, 'stdio', '--data-dir', first.dir], env: { PATH: process.env.PATH, HOME: first.dir }, stderr: 'pipe' }));
  try { const r = await c.callTool({ name: 'ticket_get', arguments: { id: 'IT-1015' } }); assert.equal(r.structuredContent.title, 'Persist me please'); } finally { await c.close(); }
});
