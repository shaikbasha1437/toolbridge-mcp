/* Builds the browser vendor files the playground loads (committed, so GitHub Pages needs no build step):
   - vendor/mcp/mcp-sdk.js: the official MCP TypeScript SDK v2 (server + client) bundled for the browser
   - vendor/sqljs/: sql.js (SQLite compiled to WebAssembly), the same engine the Node server uses */
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const pkg = (n) => JSON.parse(fs.readFileSync(path.join(root, 'node_modules', n, 'package.json'), 'utf8')).version;
const entry = path.join(root, 'scripts', '.mcp-entry.mjs');
fs.writeFileSync(entry, "export { McpServer, fromJsonSchema, createMcpHandler, ResourceTemplate, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/server';\nexport { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';\n");
await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true, legalComments: 'eof', outfile: path.join(root, 'vendor/mcp/mcp-sdk.js'), banner: { js: '/* @modelcontextprotocol/server ' + pkg('@modelcontextprotocol/server') + ' + @modelcontextprotocol/client ' + pkg('@modelcontextprotocol/client') + ' (MIT), bundled with esbuild for the ToolBridge playground. */' } });
fs.unlinkSync(entry);
fs.copyFileSync(path.join(root, 'node_modules/@modelcontextprotocol/server/LICENSE'), path.join(root, 'vendor/mcp/LICENSE'));
for (const f of ['sql-wasm-browser.js', 'sql-wasm-browser.wasm']) fs.copyFileSync(path.join(root, 'node_modules/sql.js/dist', f), path.join(root, 'vendor/sqljs', f));
fs.copyFileSync(path.join(root, 'node_modules/sql.js/LICENSE'), path.join(root, 'vendor/sqljs/LICENSE'));
fs.writeFileSync(path.join(root, 'vendor/VERSIONS.json'), JSON.stringify({ '@modelcontextprotocol/server': pkg('@modelcontextprotocol/server'), '@modelcontextprotocol/client': pkg('@modelcontextprotocol/client'), 'sql.js': pkg('sql.js'), esbuild: pkg('esbuild') }, null, 2) + '\n');
console.log('vendor built');
