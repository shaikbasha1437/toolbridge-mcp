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

## Browser checks on the live site

See the section appended below after the run.

## Not verified

- Claude Desktop, Cursor and VS Code configs: documented, using the same stdio command tested with the Inspector; not run inside those apps.
- Docker image: Dockerfile written, not built.
- Jira, ServiceNow, Slack, Postgres adapters: mocked tests only.
- Live AI with real provider keys: not used (mocked responses and fake-key errors only).
- OAuth: not implemented (future work).
