/* Wires store + metrics DB + audit + rate limiter + adapters + gateway + MCP server factory for Node. */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { McpServer, fromJsonSchema, ResourceTemplate } from '@modelcontextprotocol/server';
import { createStore } from '../core/store.js';
import { createAudit } from '../core/audit.js';
import { createRateLimiter } from '../core/policy.js';
import { createGateway } from '../core/gateway.js';
import { createServerFactory } from '../core/mcp.js';
import { createMetricsDb } from '../core/sqlguard.js';
import { buildMetrics } from '../core/seed.js';
import { TOOLS } from '../core/tools.js';
import { loadAdapters } from './adapters/index.js';

const require = createRequire(import.meta.url);
export const sdk = { McpServer, fromJsonSchema, ResourceTemplate };
let sqlPromise = null;
export function loadSql() { if (!sqlPromise) { const init = require('sql.js'); sqlPromise = init(); } return sqlPromise; }

export async function createRuntime(cfg, opts) {
  const o = opts || {};
  const now = o.now || (() => Date.now());
  let load = null; let save = null;
  if (cfg.persist) {
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    const file = path.join(cfg.dataDir, 'state.json');
    load = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; } };
    save = (s) => { const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(s, null, 1)); fs.renameSync(tmp, file); };
  }
  const store = createStore({ load, save });
  let sink = null;
  if (cfg.auditFile) { fs.mkdirSync(path.dirname(cfg.auditFile), { recursive: true }); sink = (line) => fs.appendFileSync(cfg.auditFile, line + '\n', { mode: 0o600 }); }
  const audit = createAudit({ sink, now });
  const limiter = createRateLimiter(cfg.rateLimits);
  const SQL = await loadSql();
  const metrics = createMetricsDb(SQL, buildMetrics());
  const tools = await loadAdapters(TOOLS, cfg.adapters || {}, { fetch: o.fetch || globalThis.fetch, env: o.env || process.env, importer: o.importer });
  const gateway = createGateway({ store, audit, limiter, metrics: () => metrics, requireConfirm: cfg.requireConfirm !== false, now, tools, fetch: o.fetch || globalThis.fetch });
  const stdioPrincipal = { id: 'stdio:' + (cfg.stdio.name || 'local'), name: cfg.stdio.name || 'local stdio client', role: cfg.stdio.role, employee_id: cfg.stdio.employee_id || null, transport: 'stdio' };
  const factory = createServerFactory({ sdk, gateway, store, rateLimits: cfg.rateLimits, resolvePrincipal: (ctx) => (ctx && ctx.authInfo && ctx.authInfo.extra && ctx.authInfo.extra.principal) || stdioPrincipal });
  return { cfg, store, audit, limiter, metrics, gateway, factory, stdioPrincipal };
}
