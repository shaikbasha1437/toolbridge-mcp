/* STUB, untested against a real Jira site. Jira Cloud REST v3: /rest/api/3/search/jql, /issue, /issue/{key}/comment,
   /issue/{key}/transitions. Auth: basic (email + API token from an env var). */
import { httpJson, secretFrom } from './index.js';
const PRI = { P1: 'Highest', P2: 'High', P3: 'Medium', P4: 'Low' }; const PRI_BACK = { Highest: 'P1', High: 'P2', Medium: 'P3', Low: 'P4', Lowest: 'P4' };
const STATUS_BACK = (s) => { const n = String(s || '').toLowerCase(); return n.includes('progress') ? 'in_progress' : n.includes('block') ? 'blocked' : n.includes('resolv') || n === 'done' ? 'resolved' : n.includes('clos') ? 'closed' : 'open'; };
const adf = (text) => ({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
const adfText = (doc) => { const out = []; const walk = (n) => { if (!n) return; if (n.text) out.push(n.text); (n.content || []).forEach(walk); if (n.type === 'paragraph') out.push('\n'); }; walk(doc); return out.join('').trim(); };
export const jiraAdapter = {
  group: 'tickets', label: 'Jira Cloud', status: 'stub-untested',
  async create(c, deps) {
    const base = String(c.baseUrl || '').replace(/\/+$/, ''); if (!/^https:\/\//.test(base)) throw new Error('jira.baseUrl must be an https URL like https://your-site.atlassian.net');
    const project = c.projectKey || 'IT'; const email = c.email; if (!email) throw new Error('jira.email is required');
    const auth = () => 'Basic ' + Buffer.from(email + ':' + secretFrom(c, 'apiToken', deps.env)).toString('base64');
    const req = (p, init) => httpJson(deps.fetch, base + p, Object.assign({ headers: { authorization: auth(), accept: 'application/json', 'content-type': 'application/json' } }, init), 'Jira');
    const map = (i) => ({ id: i.key, title: i.fields.summary, status: STATUS_BACK(i.fields.status && i.fields.status.name), priority: PRI_BACK[i.fields.priority && i.fields.priority.name] || 'P3', category: (i.fields.labels || [])[0] || 'other', requester: i.fields.reporter ? i.fields.reporter.displayName : null, assignee: i.fields.assignee ? i.fields.assignee.displayName : null, updated_at: i.fields.updated });
    const createBody = (a) => ({ fields: { project: { key: project }, summary: a.title, description: adf(a.description), issuetype: { name: c.issueType || 'Task' }, priority: { name: PRI[a.priority || 'P3'] }, labels: [a.category || 'other'] } });
    return {
      ticketIdPattern: '^' + project + '-\\d{1,7}$',
      overrides: {
        tickets_list: { async run(a) {
          const jql = ['project = "' + project + '"'].concat(a.status === 'active' ? ['statusCategory != Done'] : [], a.priority ? ['priority = "' + PRI[a.priority] + '"'] : [], a.query ? ['text ~ "' + String(a.query).replace(/["\\]/g, ' ') + '"'] : []).join(' AND ') + ' ORDER BY created DESC';
          const j = await req('/rest/api/3/search/jql?' + new URLSearchParams({ jql, maxResults: String(a.limit || 10), fields: 'summary,status,priority,labels,reporter,assignee,updated' }) + (a.cursor ? '&nextPageToken=' + encodeURIComponent(a.cursor) : ''));
          const tickets = (j.issues || []).map(map);
          return { structured: { tickets, next_cursor: j.nextPageToken || null, total: tickets.length }, summary: tickets.length + ' Jira issue(s).', untrusted: tickets.map((t, i) => ({ path: 'tickets[' + i + '].title', source: 'Jira ' + t.id + ' summary' })) };
        } },
        ticket_get: { async run(a) {
          const i = await req('/rest/api/3/issue/' + encodeURIComponent(a.id) + '?fields=summary,description,status,priority,labels,reporter,assignee,created,updated,comment');
          const comments = ((i.fields.comment && i.fields.comment.comments) || []).map((x) => ({ author: x.author && x.author.displayName, at: x.created, text: adfText(x.body) }));
          const out = Object.assign(map(i), { body: adfText(i.fields.description), created_at: i.fields.created, comments });
          out.requester = out.requester ? { name: out.requester } : null; out.assignee = out.assignee ? { name: out.assignee } : null;
          return { structured: out, summary: out.id + ' [' + out.status + ']', untrusted: [{ path: 'title', source: 'Jira ' + out.id + ' summary' }, { path: 'body', source: 'Jira ' + out.id + ' description' }].concat(comments.map((x, n) => ({ path: 'comments[' + n + '].text', source: 'Jira ' + out.id + ' comment ' + (n + 1) }))) };
        } },
        ticket_create: {
          preview(a) { return { structured: { dry_run: true, ticket: { request: { method: 'POST', url: base + '/rest/api/3/issue', body: createBody(a) } }, next_step: 'Nothing was sent to Jira. Call again with confirm=true after the user approves.' }, summary: 'Dry run: would create a ' + project + ' issue "' + a.title + '".' }; },
          async run(a) { const j = await req('/rest/api/3/issue', { method: 'POST', body: JSON.stringify(createBody(a)) }); return { structured: { dry_run: false, ticket: { id: j.key, url: base + '/browse/' + j.key, title: a.title } }, summary: 'Created ' + j.key + '.' }; }
        },
        ticket_update: {
          async run(a) {
            const changes = [];
            const fields = {}; if (a.priority) { fields.priority = { name: PRI[a.priority] }; changes.push({ field: 'priority', from: null, to: a.priority }); }
            if (a.assignee_id) { fields.assignee = { accountId: a.assignee_id }; changes.push({ field: 'assignee_id', from: null, to: a.assignee_id }); }
            if (Object.keys(fields).length) await req('/rest/api/3/issue/' + encodeURIComponent(a.id), { method: 'PUT', body: JSON.stringify({ fields }) });
            if (a.comment) { await req('/rest/api/3/issue/' + encodeURIComponent(a.id) + '/comment', { method: 'POST', body: JSON.stringify({ body: adf(a.comment) }) }); changes.push({ field: 'comment', from: null, to: a.comment }); }
            if (a.status) {
              const tr = await req('/rest/api/3/issue/' + encodeURIComponent(a.id) + '/transitions');
              const want = (c.statusTransitions || {})[a.status]; const t = (tr.transitions || []).find((x) => x.name === want || STATUS_BACK(x.to && x.to.name) === a.status);
              if (!t) throw new Error('No Jira transition leads to status ' + a.status + '. Map it in adapters.tickets.statusTransitions.');
              await req('/rest/api/3/issue/' + encodeURIComponent(a.id) + '/transitions', { method: 'POST', body: JSON.stringify({ transition: { id: t.id } }) }); changes.push({ field: 'status', from: null, to: a.status });
            }
            return { structured: { dry_run: false, ticket: { id: a.id }, changes }, summary: 'Updated ' + a.id + '.' };
          }
        }
      }
    };
  }
};
