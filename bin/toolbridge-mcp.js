#!/usr/bin/env node
/* ToolBridge MCP command line. stdout is reserved for MCP JSON-RPC in stdio mode: everything else goes to stderr. */
import { parseArgs, loadConfig, newToken, sha256 } from '../server/config.js';
import { SERVER_VERSION } from '../core/mcp.js';
import { snippet } from '../server/snippets.js';

const HELP = `toolbridge-mcp ${SERVER_VERSION}: MCP server for (fictional) internal company tools

Usage:
  toolbridge-mcp [stdio]            Serve over stdio (Claude Desktop, Cursor, VS Code). Default.
  toolbridge-mcp http [options]     Serve Streamable HTTP on http://127.0.0.1:8787/mcp
  toolbridge-mcp token [--role R]   Print a new random token and its sha256 for the config file
  toolbridge-mcp config <client>    Print a config snippet: claude | cursor | vscode | http

Options:
  --config <file>        JSON config (default ./toolbridge.config.json if present, or $TOOLBRIDGE_CONFIG)
  --role <role>          Role for the stdio client: viewer | agent | admin (default agent)
  --host <host>          HTTP bind address (default 127.0.0.1)
  --port <port>          HTTP port (default 8787)
  --allow-origin <url>   Allow a browser origin (CORS); repeatable
  --playground           Allow the hosted playground origin (https://shaikbasha1437.github.io)
  --allow-host <name>    Accept an extra Host header (DNS-rebinding protection); repeatable
  --dev-tokens           HTTP: generate throwaway viewer/agent/admin tokens and print them to stderr
  --data-dir <dir>       Where state.json and audit.jsonl live (default ~/.toolbridge-mcp)
  --no-persist           Keep ticket changes and audit log in memory only
  --no-confirm           Let write tools apply without confirm=true (not recommended)

Environment: TOOLBRIDGE_TOKENS="viewer:<t1>,agent:<t2>", TOOLBRIDGE_ALLOWED_ORIGINS, TOOLBRIDGE_PORT,
TOOLBRIDGE_HOST, TOOLBRIDGE_DATA_DIR, TOOLBRIDGE_AUDIT_FILE, TOOLBRIDGE_STDIO_ROLE, TOOLBRIDGE_REQUIRE_CONFIRM.
All data is fictional (Brightwave Labs, *.example domains).`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { process.stderr.write(HELP + '\n'); return; }
  if (args.version) { process.stderr.write(SERVER_VERSION + '\n'); return; }
  const cmd = args._[0] || 'stdio';
  if (cmd === 'token') { const role = args.role || 'agent'; const t = newToken(role); process.stdout.write(JSON.stringify({ role, token: t, config_entry: { name: role + '-1', role, token: 'sha256:' + sha256(t) } }, null, 2) + '\n'); return; }
  if (cmd === 'config') { process.stdout.write(snippet(args._[1] || 'claude') + '\n'); return; }
  const cfg = loadConfig(args, process.env);
  const { createRuntime } = await import('../server/runtime.js');
  if (cmd === 'stdio') {
    const { serveStdio } = await import('@modelcontextprotocol/server/stdio');
    const rt = await createRuntime(cfg);
    const handle = serveStdio(rt.factory);
    process.stderr.write('toolbridge-mcp ' + SERVER_VERSION + ' on stdio (role ' + cfg.stdio.role + ', data ' + (cfg.persist ? cfg.dataDir : 'in memory') + ')\n');
    const stop = () => { Promise.resolve(handle.close()).finally(() => process.exit(0)); };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    return;
  }
  if (cmd === 'http') {
    if (args.devTokens) {
      const toks = ['viewer', 'agent', 'admin'].map((role) => ({ name: 'dev-' + role, role, token: newToken(role), employee_id: role === 'viewer' ? null : 'E011' }));
      cfg.tokens = cfg.tokens.concat(toks);
      process.stderr.write('Dev tokens (valid until this process exits):\n' + toks.map((t) => '  ' + t.role.padEnd(6) + ' ' + t.token).join('\n') + '\n');
    }
    const { createHttpServer } = await import('../server/http.js');
    const rt = await createRuntime(cfg);
    const srv = createHttpServer(rt, { onerror: (e) => process.stderr.write('mcp error: ' + e.message + '\n') });
    const addr = await srv.listen();
    const host = addr.family === 'IPv6' ? '[' + addr.address + ']' : addr.address;
    process.stderr.write('toolbridge-mcp ' + SERVER_VERSION + ' listening on http://' + host + ':' + addr.port + cfg.http.path + '\n' + 'Allowed browser origins: ' + (cfg.http.allowedOrigins.join(', ') || '(none)') + '\n');
    const stop = () => { srv.close().finally(() => process.exit(0)); };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    return;
  }
  throw new Error('Unknown command "' + cmd + '" (see --help)');
}
main().catch((e) => { process.stderr.write('toolbridge-mcp: ' + e.message + '\n'); process.exit(1); });
