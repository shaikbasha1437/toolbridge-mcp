import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../server/config.js';
import { createRuntime } from '../server/runtime.js';
import { createHttpServer } from '../server/http.js';

export const NOW = Date.parse('2026-11-13T15:30:00Z');
export function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'toolbridge-test-')); }
export const TOKENS = { viewer: 'tb_viewer_testtoken0001', agent: 'tb_agent_testtoken0002', admin: 'tb_admin_testtoken0003' };
export async function runtime(extra) {
  const dir = tmpDir();
  const cfg = loadConfig({ _: [], allowOrigin: [], allowHost: [], dataDir: dir }, {});
  cfg.tokens = [{ name: 'viewer-1', role: 'viewer', token: TOKENS.viewer }, { name: 'agent-1', role: 'agent', token: TOKENS.agent, employee_id: 'E011' }, { name: 'admin-1', role: 'admin', token: TOKENS.admin, employee_id: 'E015' }];
  Object.assign(cfg, extra && extra.cfg);
  if (extra && extra.http) Object.assign(cfg.http, extra.http);
  const rt = await createRuntime(cfg, { now: () => NOW });
  return { rt, cfg, dir };
}
export async function httpServer(extra) {
  const r = await runtime(Object.assign({ http: { port: 0, allowedOrigins: ['https://shaikbasha1437.github.io'] } }, extra));
  const srv = createHttpServer(r.rt, {});
  const addr = await srv.listen();
  return Object.assign(r, { srv, url: 'http://127.0.0.1:' + addr.port + '/mcp', port: addr.port });
}
export const principal = (role, employee_id) => ({ id: 'test:' + role, name: 'test ' + role, role, employee_id: employee_id === undefined ? 'E011' : employee_id, transport: 'test' });
export function text(r) { return (r.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n'); }
