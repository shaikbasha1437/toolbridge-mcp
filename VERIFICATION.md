# Verification

Date: 2026-11-13. Node 24.22.1. MCP spec 2026-07-28 (plus 2025-era legacy handshake). SDK: @modelcontextprotocol/server 2.4.0, /node 2.1.2, /client 2.4.0.

## Automated tests (`npm test`): 57 passing

| File | Tests | Covers |
|---|---|---|
| core.test.js | 10 | validator, redaction, injection detector + fencing, roles, rate limiter, SQL guard, audit |
| tools.test.js | 10 | every tool through the gateway: pagination, dry run vs confirm, admin-only close, viewer masking, errors |
| server-stdio.test.js | 5 | SDK client over stdio, both protocol eras, discovery, every tool, audit file, viewer denial, persistence |
| server-http.test.js | 6 | SDK client over Streamable HTTP, both eras, 401s, roles, Origin/CORS/preflight, Host (DNS rebinding), 413, 404, healthz, refuses to start without tokens |
| adapters.test.js | 5 | Jira/ServiceNow/Slack/Postgres stubs against mocked clients; env-only secrets |
| cli.test.js | 3 | `--help`, `token`, `config` |
| web.test.js | 18 | playground modules: in-page server via the bundled SDK, demo planner flows, live agent with mocked OpenAI/Anthropic/Gemini/compatible (key never in request bodies, results fenced), fake-key errors, approval decline |

## MCP Inspector CLI 2.15.0: 18/18

stdio: tools/list (13), resources/list, resources/templates/list, prompts/list, oncall_lookup, ticket_create dry run, ticket_create confirm, IT-1007 injection flagged, SQL DELETE refused, viewer denied, resources/read tickets://IT-1007, prompts/get triage_ticket, audit.jsonl written with mode 600.
HTTP: tools/list, tools/call, admin audit_recent, viewer denied, wrong token rejected.

## Browser checks on the live site: Chrome 84/84, Firefox 84/84

Playwright against https://shaikbasha1437.github.io/toolbridge-mcp/ (scripts kept outside the repo):

- Fresh visit (built-in server up in about 0.5 s, protocol 2026-07-28, 13 tools, 3 prompts), service worker active, repeat visit controlled by the SW, created tickets persist across reloads.
- Every modal (about, AI settings, connect, tool run, schema, resource, prompt, approval) closes via X, Cancel, Esc, backdrop click and browser Back. The discard prompt appears for unsaved edits (Esc and Back), and required fields never block Cancel.
- Demo flows: on-call lookup, wiki answer, IT-1007 injection flagged and not followed, SQL `DELETE` refused, metrics query, ticket create with approval (approve creates it; X, Cancel, Esc, backdrop and Back all count as deny), and viewer denial for writes and expenses.
- Tool forms: result rendering, inline required-field errors, writes default to a dry run, readable SQL guard and missing-argument errors. Also resource templates (IT-1007 warning header) and prompts/get.
- JSON-RPC log has entries and export (Authorization masked). Audit log shows ok, dry_run, denied and injection flags, and its JSONL export is redacted. Clear actions have working undo toasts (traffic, audit, chat, reset demo data, saved server).
- Live mode with fake keys gives a readable error for OpenAI, Anthropic, Gemini and OpenRouter (OpenAI returned a CORS/network error, explained in the message). The key is not in localStorage (remember off), the transcript export, the share link or the traffic log.
- 375 px mobile: no horizontal overflow on any tab, and modals fit. The theme toggles.
- Offline reload: the built-in server and demo agent still work.
- Local server: `toolbridge-mcp http --playground` on 127.0.0.1 connected from the live https page (Chrome with the local-network-access permission granted; Firefox with its LNA pref off). A wrong token gives a readable error. The connection negotiated 2026-07-28 and listed 13 tools, the agent ran against it, and the traffic tab showed the localhost URL.

Bug found by these checks and fixed: Firefox lacks `Request.prototype.body`, so the bundled SDK could not read in-page requests (the built-in server failed to start). The fetch shim now supplies a body stream.

## Not verified

- Claude Desktop, Cursor and VS Code configs: documented, using the same stdio command tested with the Inspector; not run inside those apps.
- Docker image: Dockerfile written, not built.
- Jira, ServiceNow, Slack, Postgres adapters: mocked tests only.
- Live AI with real provider keys: not used (mocked responses and fake-key errors only).
- OAuth: not implemented (future work).
