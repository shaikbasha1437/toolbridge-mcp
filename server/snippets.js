/* Copy-paste client configuration snippets (also shown in the playground). */
export const SNIPPETS = {
  claude: { file: 'claude_desktop_config.json', json: { mcpServers: { toolbridge: { command: 'npx', args: ['-y', 'github:shaikbasha1437/toolbridge-mcp', 'stdio', '--role', 'agent'] } } } },
  cursor: { file: '.cursor/mcp.json', json: { mcpServers: { toolbridge: { command: 'npx', args: ['-y', 'github:shaikbasha1437/toolbridge-mcp', 'stdio'], env: { TOOLBRIDGE_STDIO_ROLE: 'agent' } } } } },
  vscode: { file: '.vscode/mcp.json', json: { servers: { toolbridge: { type: 'stdio', command: 'npx', args: ['-y', 'github:shaikbasha1437/toolbridge-mcp', 'stdio'] } } } },
  http: { file: 'any client that speaks Streamable HTTP', json: { mcpServers: { toolbridge: { url: 'http://127.0.0.1:8787/mcp', headers: { Authorization: 'Bearer ${TOOLBRIDGE_TOKEN}' } } } } }
};
export function snippet(name) { const s = SNIPPETS[name]; if (!s) throw new Error('Unknown client "' + name + '" (claude, cursor, vscode, http)'); return '// ' + s.file + '\n' + JSON.stringify(s.json, null, 2); }
