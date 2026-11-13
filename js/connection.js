/* MCP connections for the playground. Both use the official MCP TypeScript SDK client (bundled):
   - Built-in: the real ToolBridge server factory (same core modules as the Node package) behind the SDK's
     createMcpHandler, running inside this page. Requests go through a fetch shim instead of the network.
   - Remote: any Streamable HTTP MCP server URL (your local `toolbridge-mcp http`, or a public server that allows CORS).
   Every JSON-RPC message in either direction is recorded for the Traffic tab (Authorization values masked). */
import * as SDK from '../vendor/mcp/mcp-sdk.js';
import { createStore } from '../core/store.js';
import { createAudit } from '../core/audit.js';
import { createRateLimiter } from '../core/policy.js';
import { createGateway } from '../core/gateway.js';
import { createServerFactory } from '../core/mcp.js';
import { createMetricsDb } from '../core/sqlguard.js';
import { buildMetrics } from '../core/seed.js';
import { TOOL_MAP } from '../core/tools.js';

export const INPAGE_URL = 'https://toolbridge.inpage.example/mcp';
export const DEMO_TOKENS = { viewer: 'demo-viewer', agent: 'demo-agent', admin: 'demo-admin' };
const PRINCIPALS = { viewer: { id: 'demo:viewer', name: 'Demo viewer', role: 'viewer', employee_id: 'E019' }, agent: { id: 'demo:agent', name: 'Demo agent (Sofia Rossi, IT lead)', role: 'agent', employee_id: 'E011' }, admin: { id: 'demo:admin', name: 'Demo admin (Rachel Adeyemi)', role: 'admin', employee_id: 'E015' } };

export function parseSse(text) {
  const out = []; let data = [];
  String(text).split(/\r?\n/).forEach((line) => { if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, '')); else if (line === '') { if (data.length) { try { out.push(JSON.parse(data.join('\n'))); } catch (e) { /* skip */ } data = []; } } });
  if (data.length) { try { out.push(JSON.parse(data.join('\n'))); } catch (e) { /* skip */ } }
  return out;
}
function maskHeaders(h) { const out = {}; new Headers(h || {}).forEach((v, k) => { out[k] = /authorization|api-key|cookie/i.test(k) ? v.replace(/(Bearer\s+)?.*/i, (m, b) => (b || '') + '\u2022\u2022\u2022\u2022') : v; }); return out; }
let seq = 0;
export function loggingFetch(inner, onLog) {
  return async (url, init) => {
    const t0 = performance.now(); const id = ++seq; const method = (init && init.method) || 'GET';
    let msg = null; if (init && typeof init.body === 'string') { try { msg = JSON.parse(init.body); } catch (e) { msg = init.body; } }
    onLog({ seq: id, dir: 'out', http: method, url: String(url), headers: maskHeaders(init && init.headers), msg, at: Date.now() });
    let res;
    try { res = await inner(url, init); } catch (e) { onLog({ seq: id, dir: 'in', http: method, status: 0, error: String(e && e.message || e), ms: Math.round(performance.now() - t0), at: Date.now() }); throw e; }
    const ct = res.headers.get('content-type') || '';
    const done = (body) => onLog({ seq: id, dir: 'in', http: method, status: res.status, msg: body, ms: Math.round(performance.now() - t0), at: Date.now() });
    if (/json/.test(ct)) res.clone().text().then((t) => { let b = t; try { b = JSON.parse(t); } catch (e) { /* keep text */ } done(b); }).catch(() => done(null));
    else if (/event-stream/.test(ct)) res.clone().text().then((t) => { const msgs = parseSse(t); done(msgs.length === 1 ? msgs[0] : msgs); }).catch(() => done(null));
    else done(res.status === 202 ? '(202 Accepted, no body)' : null);
    return res;
  };
}

/* The in-page server: one per page; survives role switches and reconnects. */
let inpage = null;
export async function getInpageServer(opts) {
  if (inpage) return inpage;
  const o = opts || {};
  const SQL = await window.initSqlJs({ locateFile: (f) => o.wasmBase + f.replace('sql-wasm.wasm', 'sql-wasm-browser.wasm') });
  const store = createStore({ load: o.loadState, save: o.saveState });
  const audit = createAudit({ max: 400, sink: o.onAudit });
  if (o.loadAudit) audit.load(o.loadAudit());
  const metrics = createMetricsDb(SQL, buildMetrics());
  const limiter = createRateLimiter({ perMinute: 120, writesPerMinute: 20 });
  const gateway = createGateway({ store, audit, limiter, metrics: () => metrics, requireConfirm: true, tools: TOOL_MAP });
  const factory = createServerFactory({ sdk: SDK, gateway, store, rateLimits: limiter.options, resolvePrincipal: (ctx) => (ctx.authInfo && ctx.authInfo.extra.principal) });
  const handler = SDK.createMcpHandler(factory, { responseMode: 'json' });
  const fetchImpl = async (url, init) => {
    const req = new Request(url, init);
    // Firefox does not implement Request.prototype.body; the SDK reads the body as a stream, so give it one.
    if (req.body === undefined && init && init.body != null) { const text = typeof init.body === 'string' ? init.body : await new Response(init.body).text(); Object.defineProperty(req, 'body', { value: new Response(text).body, configurable: true }); }
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') || '');
    const role = m && Object.keys(DEMO_TOKENS).find((r) => DEMO_TOKENS[r] === m[1]);
    if (!role) { audit.record({ principal: 'anonymous', role: 'none', transport: 'in-page', kind: 'auth', name: req.method + ' /mcp', outcome: 'unauthorized' }); return new Response(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized: send Authorization: Bearer <token>.' } }), { status: 401, headers: { 'content-type': 'application/json', 'www-authenticate': 'Bearer realm="toolbridge-mcp"' } }); }
    const principal = Object.assign({ transport: 'in-page' }, PRINCIPALS[role]);
    return handler.fetch(req, { authInfo: { token: '[redacted]', clientId: principal.id, scopes: [role], extra: { principal } } });
  };
  inpage = { store, audit, gateway, metrics, fetchImpl };
  return inpage;
}

/* Connect a client. target: { kind:'inpage', role } | { kind:'remote', url, token, mode } */
export async function connect(target, onLog, opts) {
  let url; let headers = {}; let inner; let mode = 'auto';
  if (target.kind === 'inpage') { const s = await getInpageServer(opts); url = INPAGE_URL; headers.authorization = 'Bearer ' + DEMO_TOKENS[target.role]; inner = s.fetchImpl; }
  else {
    url = target.url; if (target.token) headers.authorization = 'Bearer ' + target.token; inner = (u, i) => fetch(u, i); mode = target.mode || 'auto';
    if (!/^https?:\/\//i.test(url)) throw new Error('Enter a full URL starting with http:// or https://');
  }
  const client = new SDK.Client({ name: 'toolbridge-playground', version: '1.0.0' }, { versionNegotiation: { mode } });
  const transport = new SDK.StreamableHTTPClientTransport(new URL(url), { requestInit: { headers }, fetch: loggingFetch(inner, onLog) });
  try { await client.connect(transport); } catch (e) { try { await client.close(); } catch (x) { /* ignore */ } throw explain(e, target); }
  return {
    client, target,
    era: client.getProtocolEra ? client.getProtocolEra() : 'legacy',
    server: client.getServerVersion() || {}, instructions: client.getInstructions() || '', capabilities: client.getServerCapabilities() || {},
    async listAll() {
      const caps = this.capabilities; const all = async (fn, key) => { const out = []; let cursor; for (let i = 0; i < 20; i++) { const r = await fn(cursor ? { cursor } : undefined); out.push(...(r[key] || [])); if (!r.nextCursor) break; cursor = r.nextCursor; } return out; };
      const tools = caps.tools ? await all((p) => client.listTools(p), 'tools') : [];
      const resources = caps.resources ? await all((p) => client.listResources(p), 'resources') : [];
      const templates = caps.resources ? await all((p) => client.listResourceTemplates(p), 'resourceTemplates').catch(() => []) : [];
      const prompts = caps.prompts ? await all((p) => client.listPrompts(p), 'prompts') : [];
      return { tools, resources, templates, prompts };
    },
    callTool: (name, args) => client.callTool({ name, arguments: args }),
    readResource: (uri) => client.readResource({ uri }),
    getPrompt: (name, args) => client.getPrompt({ name, arguments: args }),
    close: () => client.close()
  };
}
function explain(e, target) {
  const msg = String(e && e.message || e);
  if (target.kind !== 'remote') return new Error('Could not start the built-in server: ' + msg);
  const local = /localhost|127\.0\.0\.1|\[::1\]/.test(target.url);
  if (/401|unauthori[sz]ed|authenticat/i.test(msg + ' ' + (e && e.code))) return new Error('The server rejected the token (401). Paste one of the tokens it printed at startup.');
  if (/403|forbidden/i.test(msg)) return new Error('The server refused this page (403). Start it with --playground (or --allow-origin ' + location.origin + ') so it accepts requests from this site.');
  if (/fetch|network|cors|load failed/i.test(msg)) return new Error((local ? 'Could not reach ' + target.url + '. Check that the server is running (npx github:shaikbasha1437/toolbridge-mcp http --dev-tokens --playground) and allow local network access if the browser asks.' : 'Could not reach ' + target.url + '. The server may be down or may not allow browser requests from this site (CORS).') + ' (' + msg + ')');
  return new Error('Could not connect: ' + msg);
}
