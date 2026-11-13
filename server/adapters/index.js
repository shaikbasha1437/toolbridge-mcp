/* Adapter loader. The fictional adapter (core/store.js) backs every tool by default. A config like
     "adapters": { "tickets": { "type": "jira", ... }, "directory": { "type": "slack", ... }, "metrics": { "type": "postgres", ... } }
   swaps the backend for that group of tools. Jira, ServiceNow, Slack and Postgres adapters are STUBS:
   written against the vendors' public API docs and unit-tested with mocked HTTP/DB clients only.
   They have NOT been run against real services. */
import { jiraAdapter } from './jira.js';
import { servicenowAdapter } from './servicenow.js';
import { slackAdapter } from './slack.js';
import { postgresAdapter } from './postgres.js';

export const ADAPTERS = { jira: jiraAdapter, servicenow: servicenowAdapter, slack: slackAdapter, postgres: postgresAdapter };
export const GROUPS = { tickets: ['tickets_list', 'ticket_get', 'ticket_create', 'ticket_update'], directory: ['directory_search', 'directory_get_employee'], metrics: ['metrics_query'] };

function patchPattern(schema, from, to) { return JSON.parse(JSON.stringify(schema).split(JSON.stringify(from).slice(1, -1)).join(JSON.stringify(to).slice(1, -1))); }

export async function loadAdapters(baseTools, conf, deps) {
  const tools = new Map(baseTools.map((t) => [t.name, t]));
  for (const [group, c] of Object.entries(conf || {})) {
    if (!c || !c.type || c.type === 'fictional') continue;
    if (!GROUPS[group]) throw new Error('Unknown adapter group "' + group + '" (use tickets, directory or metrics)');
    const factory = ADAPTERS[c.type];
    if (!factory) throw new Error('Unknown adapter type "' + c.type + '" for ' + group + ' (available: fictional, ' + Object.keys(ADAPTERS).join(', ') + ')');
    if (factory.group !== group) throw new Error('Adapter ' + c.type + ' serves the ' + factory.group + ' group, not ' + group);
    const a = await factory.create(c, deps);
    for (const [name, impl] of Object.entries(a.overrides)) {
      const base = tools.get(name);
      let t = Object.assign({}, base, impl, { description: base.description + ' Backend: ' + factory.label + ' (stub adapter, untested against the real service).' });
      if (a.ticketIdPattern) { t.inputSchema = patchPattern(t.inputSchema, '^IT-\\d{4}$', a.ticketIdPattern); }
      if (base.write && !impl.preview) t.preview = (args) => ({ structured: { dry_run: true, ticket: {}, changes: [], next_step: 'Preview not available for this adapter; call with confirm=true after the user approves.' }, summary: 'Dry run (no preview from ' + factory.label + ').' });
      tools.set(name, t);
    }
  }
  return tools;
}
/* Shared helper for stub adapters: one fetch with a timeout and a readable error. */
export async function httpJson(fetchFn, url, init, label) {
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 15000);
  let res; try { res = await fetchFn(url, Object.assign({}, init, { signal: ctl.signal })); } catch (e) { throw new Error(label + ' request failed: ' + (e.name === 'AbortError' ? 'timed out' : e.message)); } finally { clearTimeout(timer); }
  const text = await res.text(); let j = null; try { j = text ? JSON.parse(text) : null; } catch (e) { /* not json */ }
  if (!res.ok) throw new Error(label + ' returned HTTP ' + res.status + (j && (j.errorMessages || j.error) ? ': ' + JSON.stringify(j.errorMessages || j.error).slice(0, 200) : ''));
  return j;
}
export function secretFrom(c, key, env) { const v = c[key]; if (typeof v === 'string' && v.startsWith('env:')) { const x = env[v.slice(4)]; if (!x) throw new Error('Environment variable ' + v.slice(4) + ' is not set'); return x; } if (v) throw new Error(key + ' must reference an environment variable (env:NAME); secrets are not read from config files'); throw new Error(key + ' is required'); }
