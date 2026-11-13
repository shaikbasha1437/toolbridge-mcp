import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { httpServer, TOKENS, text } from './helpers.js';

const PG = 'https://shaikbasha1437.github.io';
async function client(url, token, mode, log) {
  const c = new Client({ name: 'http-test', version: '1.0.0' }, { versionNegotiation: { mode: mode || 'legacy' } });
  const fetchFn = async (u, init) => { if (log) log.push(JSON.parse(init.body || 'null')); return fetch(u, init); };
  await c.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: token ? { headers: { authorization: 'Bearer ' + token } } : {}, fetch: fetchFn }));
  return c;
}
const rpc = (url, headers, body) => fetch(url, { method: 'POST', headers: Object.assign({ 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, headers), body: JSON.stringify(body || { jsonrpc: '2.0', id: 1, method: 'tools/list' }) });

for (const mode of ['legacy', 'auto']) {
  test('HTTP (' + mode + '): agent token lists and calls tools; JSON-RPC traffic is plain JSON-RPC 2.0', async () => {
    const s = await httpServer();
    const log = [];
    try {
      const c = await client(s.url, TOKENS.agent, mode, log);
      assert.equal(c.getProtocolEra(), mode === 'auto' ? 'modern' : 'legacy');
      assert.equal((await c.listTools()).tools.length, 13);
      const r = await c.callTool({ name: 'ticket_create', arguments: { title: 'HTTP created ticket', description: 'Created over Streamable HTTP.', confirm: true } });
      assert.equal(r.structuredContent.ticket.requester_id, 'E011');
      const m = await c.callTool({ name: 'metrics_query', arguments: { sql: 'SELECT COUNT(*) AS n FROM deployments' } }); assert.ok(m.structuredContent.rows[0].n > 40);
      assert.ok(log.filter(Boolean).length >= 4 && log.filter(Boolean).every((x) => x.jsonrpc === '2.0'));
      assert.ok(log.some((x) => x.method === (mode === 'auto' ? 'server/discover' : 'initialize')));
      await c.close();
      const entry = s.rt.audit.all().find((e) => e.name === 'ticket_create');
      assert.equal(entry.principal, 'token:agent-1'); assert.equal(entry.transport, 'http');
    } finally { await s.srv.close(); }
  });
}
test('HTTP: missing or wrong bearer token gets 401 with WWW-Authenticate, and is audited without the token', async () => {
  const s = await httpServer();
  try {
    const a = await rpc(s.url, {}); assert.equal(a.status, 401); assert.match(a.headers.get('www-authenticate'), /^Bearer /); assert.match((await a.json()).error.message, /Authorization: Bearer/);
    const b = await rpc(s.url, { authorization: 'Bearer tb_agent_wrongtoken999' }); assert.equal(b.status, 401); assert.match((await b.json()).error.message, /not valid/);
    await assert.rejects(() => client(s.url, null), (e) => /401|unauthori[sz]ed|authenticat/i.test(String(e && e.message) + ' ' + String(e && e.code)));
    const audit = fs.readFileSync(s.cfg.auditFile, 'utf8');
    assert.match(audit, /"outcome":"unauthorized"/); assert.doesNotMatch(audit, /wrongtoken999|testtoken/);
  } finally { await s.srv.close(); }
});
test('HTTP: viewer token is denied write tools; admin can read the audit log', async () => {
  const s = await httpServer();
  try {
    const v = await client(s.url, TOKENS.viewer);
    const r = await v.callTool({ name: 'ticket_update', arguments: { id: 'IT-1003', status: 'resolved', confirm: true } });
    assert.equal(r.isError, true); assert.match(text(r), /needs the agent role, and this connection has the viewer role/);
    await v.close();
    const a = await client(s.url, TOKENS.admin);
    const log = await a.callTool({ name: 'audit_recent', arguments: { outcome: 'denied' } });
    assert.equal(log.structuredContent.entries[0].principal, 'token:viewer-1'); assert.equal(log.structuredContent.entries[0].name, 'ticket_update');
    await a.close();
  } finally { await s.srv.close(); }
});
test('HTTP: Origin allow-list, CORS preflight, DNS-rebinding Host check, body limit, unknown path', async () => {
  const s = await httpServer({ http: { port: 0, allowedOrigins: [PG], maxBodyBytes: 2048 } });
  try {
    const evil = await rpc(s.url, { origin: 'https://evil.example', authorization: 'Bearer ' + TOKENS.agent }); assert.equal(evil.status, 403); assert.match((await evil.json()).error.message, /Origin https:\/\/evil\.example is not in the allowed origins/);
    const pre = await fetch(s.url, { method: 'OPTIONS', headers: { origin: PG, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization, content-type, mcp-protocol-version' } });
    assert.equal(pre.status, 204); assert.equal(pre.headers.get('access-control-allow-origin'), PG); assert.match(pre.headers.get('access-control-allow-headers'), /authorization/); assert.match(pre.headers.get('access-control-allow-headers'), /mcp-protocol-version/); assert.equal(pre.headers.get('access-control-allow-private-network'), 'true');
    const preEvil = await fetch(s.url, { method: 'OPTIONS', headers: { origin: 'https://evil.example' } }); assert.equal(preEvil.status, 403); assert.equal(preEvil.headers.get('access-control-allow-origin'), null);
    const ok = await rpc(s.url, { origin: PG, authorization: 'Bearer ' + TOKENS.agent }, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'x', version: '1' } } });
    assert.equal(ok.status, 200); assert.equal(ok.headers.get('access-control-allow-origin'), PG); assert.equal(ok.headers.get('vary'), 'Origin');
    const noAuthCors = await rpc(s.url, { origin: PG }); assert.equal(noAuthCors.status, 401); assert.equal(noAuthCors.headers.get('access-control-allow-origin'), PG, '401 is readable by the allowed page');
    // DNS rebinding: a page on attacker.example resolved to 127.0.0.1 sends Host: attacker.example
    const http = await import('node:http');
    const status = await new Promise((resolve) => { const req = http.request({ host: '127.0.0.1', port: s.port, path: '/mcp', method: 'POST', headers: { host: 'attacker.example:' + s.port, 'content-type': 'application/json', authorization: 'Bearer ' + TOKENS.agent } }, (res) => resolve(res.statusCode)); req.end('{}'); });
    assert.equal(status, 403);
    const big = await rpc(s.url, { authorization: 'Bearer ' + TOKENS.agent }, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { pad: 'x'.repeat(5000) } }); assert.equal(big.status, 413);
    const nf = await fetch(s.url.replace('/mcp', '/other')); assert.equal(nf.status, 404);
    const hz = await fetch(s.url.replace('/mcp', '/healthz')); assert.equal((await hz.json()).ok, true);
    const rej = s.rt.audit.all().filter((e) => e.kind === 'auth').map((e) => e.detail.reason);
    assert.ok(rej.includes('origin not allowed') && rej.includes('host not allowed') && rej.includes('body too large'));
  } finally { await s.srv.close(); }
});
test('HTTP: refuses to start without tokens', async () => {
  const { runtime } = await import('./helpers.js'); const { createHttpServer } = await import('../server/http.js');
  const r = await runtime(); r.rt.cfg.tokens = [];
  assert.throws(() => createHttpServer(r.rt, {}), /needs at least one token/);
});
