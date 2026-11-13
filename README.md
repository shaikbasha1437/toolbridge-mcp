# ToolBridge MCP

**An MCP server that connects an AI assistant to internal company tools, with the guardrails you'd want before letting it near real systems.**

Live playground: **https://shaikbasha1437.github.io/toolbridge-mcp/** (runs the same server code in your browser; no install, no key needed)

ToolBridge is a [Model Context Protocol](https://modelcontextprotocol.io) server built on the official TypeScript SDK (v2). It exposes the internal tools of a **fictional** company, Brightwave Labs (directory, wiki, IT tickets, on-call, assets, expenses and a read-only metrics database), to any MCP client: Claude Desktop, Cursor, VS Code, the MCP Inspector, or your own agent.

The point of the project is the safety layer around the tools, not the tools themselves:

| Concern | What ToolBridge does |
|---|---|
| Who can do what | Three roles (`viewer`, `agent`, `admin`). Every tool declares a minimum role; HTTP tokens map to a role. |
| Accidental writes | Write tools (`ticket_create`, `ticket_update`) are **dry runs unless `confirm: true`**. The dry run returns exactly what would change. Closing a ticket needs `admin`. |
| Prompt injection | Text written by users (ticket bodies, wiki pages, comments) is wrapped in `<untrusted_data>` fences, and a detector flags text that addresses the AI, asks for secrets, or tries to call tools. Ticket **IT-1007** and one wiki page contain planted injections so you can see it work. |
| SQL | `metrics_query` accepts a single `SELECT`/`WITH` over four allow-listed tables, no PRAGMA, no `sqlite_` objects, no recursive CTEs, row cap; the database is opened with `query_only`. |
| Audit | Every tool call, resource read, prompt fetch and auth failure is a JSONL line (file mode 0600) with secrets, emails, phones, card numbers and salary data redacted. |
| Abuse | Per-principal rate limits (60 calls/min, 10 writes/min by default), JSON Schema input validation with readable errors, 1 MB body limit. |
| Network | Streamable HTTP binds to `127.0.0.1`, requires a bearer token, checks the `Host` header (DNS-rebinding protection), rejects unknown `Origin`s and only sends CORS headers for configured origins. |
| Blast radius | No shell, no filesystem, no arbitrary HTTP tools. Adapter secrets can only come from environment variables. |

## Protocol and SDK versions

- MCP specification **2026-07-28** (stateless requests, `server/discover`), with the 2025-era `initialize` handshake still served for older clients. Both are tested.
- `@modelcontextprotocol/server` **2.4.0**, `@modelcontextprotocol/node` **2.1.2**, `@modelcontextprotocol/client` **2.4.0** (tests and playground).
- Node.js 20.19+ (developed and tested on Node 24).

## Quick start

```bash
# stdio (what desktop clients launch)
npx -y github:shaikbasha1437/toolbridge-mcp stdio --role agent

# Streamable HTTP on http://127.0.0.1:8787/mcp with throwaway tokens printed to stderr,
# allowing the hosted playground to connect from your browser
npx -y github:shaikbasha1437/toolbridge-mcp http --dev-tokens --playground

# Look at it with the MCP Inspector
npx @modelcontextprotocol/inspector --cli npx -y github:shaikbasha1437/toolbridge-mcp stdio --method tools/list
```

Or from a clone: `npm install`, then `node bin/toolbridge-mcp.js --help`.

State (tickets you create or change) and `audit.jsonl` go to `~/.toolbridge-mcp` (`--data-dir` to change, `--no-persist` to keep everything in memory).

## Client configuration

`toolbridge-mcp config <claude|cursor|vscode|http>` prints these. Files are also in [`examples/`](examples).

**Claude Desktop** (`claude_desktop_config.json`)
```json
{ "mcpServers": { "toolbridge": { "command": "npx", "args": ["-y", "github:shaikbasha1437/toolbridge-mcp", "stdio", "--role", "agent"] } } }
```

**Cursor** (`.cursor/mcp.json`)
```json
{ "mcpServers": { "toolbridge": { "command": "npx", "args": ["-y", "github:shaikbasha1437/toolbridge-mcp", "stdio"], "env": { "TOOLBRIDGE_STDIO_ROLE": "agent" } } } }
```

**VS Code** (`.vscode/mcp.json`)
```json
{ "servers": { "toolbridge": { "type": "stdio", "command": "npx", "args": ["-y", "github:shaikbasha1437/toolbridge-mcp", "stdio"] } } }
```

**Any Streamable HTTP client**
```json
{ "mcpServers": { "toolbridge": { "url": "http://127.0.0.1:8787/mcp", "headers": { "Authorization": "Bearer ${TOOLBRIDGE_TOKEN}" } } } }
```

What was actually tested: the stdio command and the HTTP endpoint with the **MCP Inspector CLI 2.15.0** and the official SDK client (Node tests). The Claude Desktop, Cursor and VS Code snippets use that same tested command but were **not** run inside those apps.

## What the server exposes

**Tools** (13). All have titles, annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`), an `outputSchema` with `structuredContent`, and cursor pagination where lists can be long.

| Tool | Min role | Notes |
|---|---|---|
| `directory_search`, `directory_get_employee` | viewer | Search returns public fields only (no phones); salary band only for admins |
| `wiki_search`, `wiki_get_page` | viewer | Returns `resource_link`s to `wiki://pages/{slug}` |
| `tickets_list`, `ticket_get` | viewer | Filters, pagination, fenced user text |
| `ticket_create` | agent | Dry run unless `confirm: true` |
| `ticket_update` | agent | Dry run unless `confirm: true`; closing needs admin; destructive |
| `oncall_lookup` | viewer | Weekly rotations, optional `at` time |
| `asset_lookup` | viewer | Laptops and devices |
| `expense_lookup` | agent | With policy notes (limits, receipts) |
| `metrics_query` | agent | Guarded read-only SQL over metrics, deployments, incidents, tickets |
| `audit_recent` | admin | Recent audit entries |

**Resources:** `schema://metrics`, `toolbridge://policy`, `directory://org-chart`, templates `wiki://pages/{slug}` and `tickets://{id}`.
**Prompts:** `triage_ticket` (embeds the ticket resource), `weekly_status`, `onboarding_plan`.

## Configuration

Layers: defaults, then `toolbridge.config.json` (or `--config`/`TOOLBRIDGE_CONFIG`), then environment variables, then flags. See [`toolbridge.config.example.json`](toolbridge.config.example.json).

- Tokens: `TOOLBRIDGE_TOKENS="viewer:<t1>,agent:<t2>"`, or config entries whose `token` is `sha256:<hex>` (from `toolbridge-mcp token --role agent`) or `env:VAR`. Compared in constant time. The HTTP server refuses to start without at least one token.
- Origins: `--allow-origin https://example.com` (repeatable) or `TOOLBRIDGE_ALLOWED_ORIGINS`; `--playground` adds `https://shaikbasha1437.github.io`.
- Other env: `TOOLBRIDGE_PORT`, `TOOLBRIDGE_HOST`, `TOOLBRIDGE_DATA_DIR`, `TOOLBRIDGE_AUDIT_FILE`, `TOOLBRIDGE_STDIO_ROLE`, `TOOLBRIDGE_REQUIRE_CONFIRM`.

### Adapters (stubs, untested)

The fictional data backs every tool by default. `adapters` in the config can swap a group of tools onto a real backend: **Jira** or **ServiceNow** for tickets, **Slack** for the directory, **Postgres** (read-only transaction) for metrics. See [`examples/adapters.config.example.json`](examples/adapters.config.example.json).

> These adapters were written from the vendors' public API docs and are unit-tested only with mocked HTTP and database clients. **They have never been run against real Jira, ServiceNow, Slack or Postgres.** Treat them as a starting point. Secrets must be given as `env:VAR`.

### Docker

```bash
docker build -t toolbridge-mcp .
docker run --rm -p 127.0.0.1:8787:8787 -e TOOLBRIDGE_TOKENS="agent:$(openssl rand -hex 24)" toolbridge-mcp
```
The Dockerfile was written but **not built** during development (no container runtime was available).

## The playground

https://shaikbasha1437.github.io/toolbridge-mcp/ bundles the SDK's `McpServer` and `Client` with esbuild and runs the real ToolBridge server factory inside the page. The client talks to it through a `fetch` shim, so the JSON-RPC traffic you see is genuine.

- Browse tools (schemas, annotations), resources, templates and prompts; call anything through generated forms.
- **JSON-RPC** tab: every request and response, Authorization masked. **Audit log** tab: what the server recorded. Both export (JSON / JSONL) and clear with undo.
- Switch role between viewer, agent and admin.
- **Agent** tab:
  - **Demo planner** (default, no key): a deterministic rule-based planner, not AI, that picks tools and writes answers from their results.
  - **Live AI**: your own key for OpenAI, Anthropic, Google Gemini, or any OpenAI-compatible endpoint (OpenRouter, Ollama, LM Studio), with real function calling. Before any call that would change data, you see the dry-run preview and choose **Approve** or **Deny**.
  - Keys stay in the browser (memory by default, localStorage only if you tick remember). They go only to the provider, never into prompts, transcripts, exports or share links.
  - Tool results reach the model wrapped as `<tool_result untrusted="true">` data.
- **Connect…** to your local `toolbridge-mcp http --dev-tokens --playground` (Chrome and Edge may show a *local network access* permission prompt; allow it. Safari may block `http://localhost` from an https page.) or to any public MCP server URL that allows CORS.
- Installable PWA, works offline, light and dark themes.

## Development

```bash
npm install
npm test                 # Node tests: core, every tool, SDK client over stdio + HTTP, adapters, CLI, playground modules
npm run build:vendor     # rebuild vendor/ (SDK browser bundle + sql.js)
```
The `test` GitHub Action runs the tests and an MCP Inspector CLI smoke test on Node 24.

## Future work

- **OAuth 2.1** authorization (protected resource metadata, per-user scopes) instead of static bearer tokens. The spec's authorization flow is the right way to put this in front of real systems.
- Running the adapters against sandbox instances of Jira, ServiceNow, Slack and Postgres.
- Elicitation for write approvals inside clients that support it.

## License

MIT. All company data, people and domains (`*.example`) are fictional.
