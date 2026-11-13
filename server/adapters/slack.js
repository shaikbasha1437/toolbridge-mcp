/* STUB, untested against a real Slack workspace. Uses users.lookupByEmail (scope users:read.email) for
   directory_get_employee by email, and users.list for directory_search. Bot token comes from an env var. */
import { httpJson, secretFrom } from './index.js';
import { ToolError } from '../../core/tools.js';
export const slackAdapter = {
  group: 'directory', label: 'Slack', status: 'stub-untested',
  async create(c, deps) {
    const api = (method, params) => httpJson(deps.fetch, 'https://slack.com/api/' + method + '?' + new URLSearchParams(params || {}), { headers: { authorization: 'Bearer ' + secretFrom(c, 'botToken', deps.env) } }, 'Slack').then((j) => { if (!j.ok) throw new Error('Slack ' + method + ' error: ' + j.error); return j; });
    const map = (u) => ({ id: u.id, name: u.real_name || u.name, email: u.profile && u.profile.email, title: (u.profile && u.profile.title) || '', department: '', team: '', location: u.tz || '' });
    return {
      overrides: {
        directory_get_employee: { async run(a) {
          if (!a.email) throw new ToolError('The Slack adapter looks people up by email.', 'Pass email instead of id.', 'MISSING_FIELD');
          const j = await api('users.lookupByEmail', { email: a.email });
          const out = Object.assign(map(j.user), { phone: (j.user.profile && j.user.profile.phone) || '', skills: [], manager: null, direct_reports: [] });
          return { structured: out, summary: out.name + ' (Slack profile)' };
        } },
        directory_search: { async run(a) {
          const j = await api('users.list', { limit: '200', cursor: a.cursor || '' });
          const q = String(a.query || '').toLowerCase();
          const list = (j.members || []).filter((u) => !u.deleted && !u.is_bot && (!q || JSON.stringify([u.real_name, u.name, u.profile && u.profile.title]).toLowerCase().includes(q))).slice(0, a.limit || 10).map(map);
          return { structured: { employees: list, next_cursor: (j.response_metadata && j.response_metadata.next_cursor) || null, total: list.length }, summary: list.length + ' Slack member(s) matched.' };
        } }
      }
    };
  }
};
