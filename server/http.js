/* Streamable HTTP transport: localhost by default, bearer-token auth (role per token), Host-header check
   against DNS rebinding, Origin allow-list with CORS for exactly those origins, body-size limit. */
import http from 'node:http';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { compileTokens, matchToken } from './config.js';

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]', '::1'];
function hostname(hostHeader) { const h = String(hostHeader || '').trim().toLowerCase(); if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1); return h.split(':')[0]; }
function jsonError(res, status, code, message, extraHeaders) {
  res.writeHead(status, Object.assign({ 'content-type': 'application/json', 'cache-control': 'no-store' }, extraHeaders || {}));
  res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code, message } }));
}
export function createHttpServer(rt, opts) {
  const cfg = rt.cfg; const H = cfg.http; const o = opts || {};
  const tokens = compileTokens(cfg.tokens, o.env);
  if (!tokens.length) throw new Error('HTTP mode needs at least one token. Set TOOLBRIDGE_TOKENS="agent:<secret>", add "tokens" to the config file, or run with --dev-tokens for local testing.');
  const allowedHosts = new Set(LOCAL_HOSTS.concat(H.allowedHosts.map((h) => h.toLowerCase())));
  const allowedOrigins = new Set(H.allowedOrigins);
  const mcp = createMcpHandler(rt.factory, { onerror: o.onerror });
  const nodeHandler = toNodeHandler(mcp);
  const audit = (outcome, detail, req) => rt.audit.record({ principal: 'anonymous', role: 'none', transport: 'http', kind: 'auth', name: req.method + ' ' + (req.url || ''), outcome, detail: Object.assign({ origin: req.headers.origin || null, host: req.headers.host || null }, detail) });
  function cors(req) {
    const origin = req.headers.origin; if (!origin || !allowedOrigins.has(origin)) return {};
    return { 'access-control-allow-origin': origin, vary: 'Origin', 'access-control-allow-credentials': 'false', 'access-control-expose-headers': 'mcp-session-id, mcp-protocol-version, www-authenticate', 'access-control-max-age': '600' };
  }
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const host = hostname(req.headers.host);
    if (!allowedHosts.has(host)) { audit('rejected', { reason: 'host not allowed' }, req); return jsonError(res, 403, -32000, 'Forbidden: Host "' + host + '" is not allowed (DNS-rebinding protection). Add it with --allow-host if this is intended.'); }
    const origin = req.headers.origin;
    if (origin && !allowedOrigins.has(origin.replace(/\/+$/, ''))) { audit('rejected', { reason: 'origin not allowed' }, req); return jsonError(res, 403, -32000, 'Forbidden: Origin ' + origin + ' is not in the allowed origins. Start the server with --allow-origin ' + origin + ' to permit it.'); }
    const c = cors(req);
    if (req.method === 'OPTIONS') {
      res.writeHead(204, Object.assign({}, c, { 'access-control-allow-methods': 'POST, GET, DELETE, OPTIONS', 'access-control-allow-headers': 'authorization, content-type, accept, mcp-protocol-version, mcp-session-id, mcp-method, mcp-name, last-event-id', 'access-control-allow-private-network': 'true' }));
      return res.end();
    }
    if (url.pathname === '/healthz' && req.method === 'GET') { res.writeHead(200, Object.assign({ 'content-type': 'application/json' }, c)); return res.end(JSON.stringify({ ok: true, name: 'toolbridge-mcp' })); }
    if (url.pathname !== H.path) { res.writeHead(404, Object.assign({ 'content-type': 'application/json' }, c)); return res.end(JSON.stringify({ error: 'Not found. The MCP endpoint is ' + H.path })); }
    for (const [k, v] of Object.entries(c)) res.setHeader(k, v);
    const len = Number(req.headers['content-length'] || 0);
    if (len > H.maxBodyBytes) { audit('rejected', { reason: 'body too large', bytes: len }, req); return jsonError(res, 413, -32000, 'Request body too large (max ' + H.maxBodyBytes + ' bytes).'); }
    const m = /^Bearer\s+(\S+)\s*$/i.exec(String(req.headers.authorization || ''));
    const tok = m ? matchToken(tokens, m[1]) : null;
    if (!tok) {
      audit('unauthorized', { reason: m ? 'unknown token' : 'missing bearer token' }, req);
      return jsonError(res, 401, -32001, m ? 'Unauthorized: the bearer token is not valid.' : 'Unauthorized: send Authorization: Bearer <token>.', { 'www-authenticate': 'Bearer realm="toolbridge-mcp", error="invalid_token"' });
    }
    req.auth = { token: '[redacted]', clientId: tok.name, scopes: [tok.role], extra: { principal: { id: 'token:' + tok.name, name: tok.name, role: tok.role, employee_id: tok.employee_id, transport: 'http' } } };
    try { await nodeHandler(req, res); } catch (e) { if (!res.headersSent) jsonError(res, 500, -32603, 'Internal server error'); }
  });
  server.requestTimeout = 120000; server.headersTimeout = 30000;
  return {
    server, mcp,
    listen() { return new Promise((resolve, reject) => { server.once('error', reject); server.listen(H.port, H.host, () => resolve(server.address())); }); },
    async close() { await mcp.close().catch(() => {}); await new Promise((r) => server.close(() => r())); }
  };
}
