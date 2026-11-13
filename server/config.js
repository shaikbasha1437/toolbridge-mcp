/* Configuration: defaults <- JSON config file <- environment variables <- CLI flags. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const PLAYGROUND_ORIGIN = 'https://shaikbasha1437.github.io';
export const DEFAULTS = {
  http: { host: '127.0.0.1', port: 8787, path: '/mcp', allowedOrigins: [], allowedHosts: [], maxBodyBytes: 1048576 },
  tokens: [],
  stdio: { role: 'agent', name: 'local-stdio', employee_id: 'E011' },
  requireConfirm: true,
  rateLimits: { perMinute: 60, writesPerMinute: 10 },
  dataDir: path.join(os.homedir(), '.toolbridge-mcp'),
  persist: true,
  auditFile: null,
  adapters: {}
};
const ROLES = ['viewer', 'agent', 'admin'];

export function parseArgs(argv) {
  const out = { _: [], allowOrigin: [], allowHost: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { const v = argv[++i]; if (v === undefined) throw new Error('Missing value for ' + a); return v; };
    if (a === '--port') out.port = Number(val());
    else if (a === '--host') out.host = val();
    else if (a === '--config') out.config = val();
    else if (a === '--allow-origin') out.allowOrigin.push(val());
    else if (a === '--allow-host') out.allowHost.push(val());
    else if (a === '--playground') out.playground = true;
    else if (a === '--dev-tokens') out.devTokens = true;
    else if (a === '--data-dir') out.dataDir = val();
    else if (a === '--no-persist') out.persist = false;
    else if (a === '--role') out.role = val();
    else if (a === '--no-confirm') out.noConfirm = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--version' || a === '-v') out.version = true;
    else if (a.startsWith('--')) throw new Error('Unknown option ' + a + ' (see --help)');
    else out._.push(a);
  }
  return out;
}
function splitList(s) { return String(s || '').split(',').map((x) => x.trim()).filter(Boolean); }
/* TOOLBRIDGE_TOKENS="viewer:abc123,agent:def456" -> token entries (plain tokens from env, never written to disk). */
export function tokensFromEnv(s) {
  return splitList(s).map((pair, i) => { const [role, token] = pair.split(':'); if (!ROLES.includes(role) || !token) throw new Error('TOOLBRIDGE_TOKENS entry ' + (i + 1) + ' must look like role:token with role viewer, agent or admin'); return { name: 'env-' + role + '-' + (i + 1), role, token }; });
}
export function loadConfig(args, env) {
  const e = env || process.env; const a = args || { _: [], allowOrigin: [], allowHost: [] };
  const cfg = JSON.parse(JSON.stringify(DEFAULTS));
  const file = a.config || e.TOOLBRIDGE_CONFIG || (fs.existsSync('toolbridge.config.json') ? 'toolbridge.config.json' : null);
  if (file) {
    let fileCfg; try { fileCfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) { throw new Error('Could not read config ' + file + ': ' + err.message); }
    Object.assign(cfg, fileCfg, { http: Object.assign(cfg.http, fileCfg.http || {}), stdio: Object.assign(cfg.stdio, fileCfg.stdio || {}), rateLimits: Object.assign(cfg.rateLimits, fileCfg.rateLimits || {}) });
    cfg.configFile = path.resolve(file);
  }
  if (e.TOOLBRIDGE_HOST) cfg.http.host = e.TOOLBRIDGE_HOST;
  if (e.TOOLBRIDGE_PORT) cfg.http.port = Number(e.TOOLBRIDGE_PORT);
  if (e.TOOLBRIDGE_ALLOWED_ORIGINS) cfg.http.allowedOrigins = cfg.http.allowedOrigins.concat(splitList(e.TOOLBRIDGE_ALLOWED_ORIGINS));
  if (e.TOOLBRIDGE_ALLOWED_HOSTS) cfg.http.allowedHosts = cfg.http.allowedHosts.concat(splitList(e.TOOLBRIDGE_ALLOWED_HOSTS));
  if (e.TOOLBRIDGE_TOKENS) cfg.tokens = cfg.tokens.concat(tokensFromEnv(e.TOOLBRIDGE_TOKENS));
  if (e.TOOLBRIDGE_DATA_DIR) cfg.dataDir = e.TOOLBRIDGE_DATA_DIR;
  if (e.TOOLBRIDGE_AUDIT_FILE) cfg.auditFile = e.TOOLBRIDGE_AUDIT_FILE;
  if (e.TOOLBRIDGE_STDIO_ROLE) cfg.stdio.role = e.TOOLBRIDGE_STDIO_ROLE;
  if (e.TOOLBRIDGE_REQUIRE_CONFIRM) cfg.requireConfirm = !/^(0|false|no)$/i.test(e.TOOLBRIDGE_REQUIRE_CONFIRM);
  if (e.TOOLBRIDGE_PERSIST) cfg.persist = !/^(0|false|no)$/i.test(e.TOOLBRIDGE_PERSIST);
  if (a.host) cfg.http.host = a.host;
  if (a.port != null) cfg.http.port = a.port;
  if (a.dataDir) cfg.dataDir = a.dataDir;
  if (a.persist === false) cfg.persist = false;
  if (a.role) cfg.stdio.role = a.role;
  if (a.noConfirm) cfg.requireConfirm = false;
  cfg.http.allowedOrigins = cfg.http.allowedOrigins.concat(a.allowOrigin || []);
  cfg.http.allowedHosts = cfg.http.allowedHosts.concat(a.allowHost || []);
  if (a.playground) cfg.http.allowedOrigins.push(PLAYGROUND_ORIGIN);
  cfg.http.allowedOrigins = Array.from(new Set(cfg.http.allowedOrigins.map((o) => o.replace(/\/+$/, ''))));
  if (!ROLES.includes(cfg.stdio.role)) throw new Error('stdio role must be viewer, agent or admin (got ' + cfg.stdio.role + ')');
  if (!cfg.auditFile && cfg.persist) cfg.auditFile = path.join(cfg.dataDir, 'audit.jsonl');
  return cfg;
}
export function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }
export function newToken(role) { return 'tb_' + role + '_' + crypto.randomBytes(18).toString('base64url'); }
/* Resolve a configured token entry to the secret hash we compare against. Supports literal tokens,
   "env:VAR" indirection and pre-hashed "sha256:<hex>" so config files never need plain secrets. */
export function compileTokens(entries, env) {
  const e = env || process.env;
  return (entries || []).map((t, i) => {
    if (!ROLES.includes(t.role)) throw new Error('Token ' + (t.name || i + 1) + ' has an unknown role ' + t.role);
    let hash = null; const raw = t.token || '';
    if (raw.startsWith('sha256:')) hash = raw.slice(7).toLowerCase();
    else if (raw.startsWith('env:')) { const v = e[raw.slice(4)]; if (!v) throw new Error('Token ' + (t.name || i + 1) + ' reads ' + raw + ' but that environment variable is empty'); hash = sha256(v); }
    else if (raw) hash = sha256(raw);
    if (!hash || !/^[0-9a-f]{64}$/.test(hash)) throw new Error('Token ' + (t.name || i + 1) + ' is missing or malformed');
    return { name: t.name || t.role + '-' + (i + 1), role: t.role, employee_id: t.employee_id || null, hash };
  });
}
export function matchToken(compiled, presented) {
  if (!presented) return null; const h = Buffer.from(sha256(presented), 'hex');
  let found = null;
  for (const t of compiled) { if (crypto.timingSafeEqual(h, Buffer.from(t.hash, 'hex')) && !found) found = t; }
  return found;
}
