import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs, loadConfig, tokensFromEnv, compileTokens, matchToken, sha256 } from '../server/config.js';
import { tmpDir } from './helpers.js';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'toolbridge-mcp.js');
const run = (args, env) => spawnSync(process.execPath, [BIN].concat(args), { encoding: 'utf8', env: Object.assign({ PATH: process.env.PATH, HOME: tmpDir() }, env || {}), timeout: 20000 });

test('cli: --help, token, config snippets, unknown option', () => {
  assert.match(run(['--help']).stderr, /toolbridge-mcp http \[options\]/);
  const t = JSON.parse(run(['token', '--role', 'viewer']).stdout);
  assert.match(t.token, /^tb_viewer_/); assert.equal(t.config_entry.token, 'sha256:' + sha256(t.token));
  for (const c of ['claude', 'cursor', 'vscode', 'http']) { const out = run(['config', c]).stdout; JSON.parse(out.split('\n').slice(1).join('\n')); assert.match(out, /toolbridge/); }
  const bad = run(['http', '--bogus']); assert.equal(bad.status, 1); assert.match(bad.stderr, /Unknown option --bogus/);
  const nt = run(['http', '--port', '0', '--no-persist']); assert.equal(nt.status, 1); assert.match(nt.stderr, /needs at least one token/);
});
test('cli: http --dev-tokens prints tokens to stderr and serves', async () => {
  const p = spawn(process.execPath, [BIN, 'http', '--port', '0', '--dev-tokens', '--no-persist', '--playground'], { env: { PATH: process.env.PATH, HOME: tmpDir() } });
  let err = ''; p.stderr.on('data', (d) => { err += d; });
  try {
    await new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('timeout: ' + err)), 15000); p.stderr.on('data', () => { if (/listening on/.test(err)) { clearTimeout(t); res(); } }); });
    assert.match(err, /agent\s+tb_agent_/); assert.match(err, /Allowed browser origins: https:\/\/shaikbasha1437\.github\.io/);
    const port = /:(\d+)\/mcp/.exec(err)[1]; const tok = /agent\s+(tb_agent_\S+)/.exec(err)[1];
    const r = await fetch('http://127.0.0.1:' + port + '/mcp', { method: 'POST', headers: { authorization: 'Bearer ' + tok, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'c', version: '1' } } }) });
    assert.equal(r.status, 200);
  } finally { p.kill('SIGTERM'); }
});
test('config: file + env + flags merge; tokens via env, env: indirection and sha256 hashes', () => {
  const dir = tmpDir(); const file = path.join(dir, 'c.json');
  fs.writeFileSync(file, JSON.stringify({ http: { port: 9000, allowedOrigins: ['http://localhost:5173'] }, tokens: [{ name: 'ci', role: 'viewer', token: 'sha256:' + sha256('s3cret') }, { name: 'bot', role: 'agent', token: 'env:BOT_TOKEN' }], stdio: { role: 'viewer' } }));
  const cfg = loadConfig(parseArgs(['--config', file, '--port', '9100', '--allow-origin', 'https://app.example/', '--playground']), { TOOLBRIDGE_TOKENS: 'admin:adm1n', TOOLBRIDGE_ALLOWED_ORIGINS: 'https://b.example' });
  assert.equal(cfg.http.port, 9100); assert.equal(cfg.stdio.role, 'viewer');
  assert.deepEqual(cfg.http.allowedOrigins, ['http://localhost:5173', 'https://b.example', 'https://app.example', 'https://shaikbasha1437.github.io']);
  const compiled = compileTokens(cfg.tokens, { BOT_TOKEN: 'b0t' });
  assert.equal(matchToken(compiled, 's3cret').name, 'ci'); assert.equal(matchToken(compiled, 'b0t').role, 'agent'); assert.equal(matchToken(compiled, 'adm1n').role, 'admin'); assert.equal(matchToken(compiled, 'nope'), null);
  assert.throws(() => compileTokens([{ role: 'agent', token: 'env:MISSING' }], {}), /environment variable is empty/);
  assert.throws(() => tokensFromEnv('root:x'), /role:token/);
  assert.throws(() => loadConfig(parseArgs(['--role', 'superuser']), {}), /stdio role/);
});
