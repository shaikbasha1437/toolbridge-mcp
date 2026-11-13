/* ToolBridge MCP playground: wires the in-page MCP server (or a remote one) to the UI. */
import { $, $$, esc, md, toast, openModal, closeModal, setDirty, modalOpen, download, schemaForm, readForm } from './ui.js';
import { connect, getInpageServer, INPAGE_URL } from './connection.js';
import { runDemoAgent, EXAMPLES } from './planner.js';
import { runLiveAgent, isReadOnly } from './agent.js';
import * as LLM from './llm.js';
import { SNIPPETS } from '../server/snippets.js';

const LS = { get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* quota or private mode */ } }, del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } } };
const DEFAULT_SETTINGS = { mode: 'demo', provider: 'openai', models: {}, baseUrl: '', remember: false, role: 'agent', target: { kind: 'inpage' }, saved: [] };
const S = Object.assign({}, DEFAULT_SETTINGS, LS.get('tb.settings', {}));
let keys = LS.get('tb.keys', {}); // only filled when "remember" is on; otherwise keys live in memory for this tab
const memKeys = {}; const memTokens = {};
const savedTokens = LS.get('tb.tokens', {});
function saveSettings() { LS.set('tb.settings', S); }
function keyFor(p) { return memKeys[p] || keys[p] || ''; }

const app = { conn: null, cat: { tools: [], resources: [], templates: [], prompts: [] }, tab: 'agent', traffic: [], chat: [], liveHistory: [], busy: false, abort: null, error: '' };
const persistAudit = debounce(() => { if (app.inpage) LS.set('tb.audit', app.inpage.audit.all()); }, 300);
function debounce(fn, ms) { let t; return () => { clearTimeout(t); t = setTimeout(fn, ms); }; }
const inpageOpts = { wasmBase: new URL('../vendor/sqljs/', import.meta.url).href, loadState: () => LS.get('tb.state', null), saveState: (s) => LS.set('tb.state', s), onAudit: () => { persistAudit(); renderCounts(); if (app.tab === 'audit') renderPanel(); }, loadAudit: () => LS.get('tb.audit', []) };

function onLog(e) { app.traffic.push(e); if (app.traffic.length > 600) app.traffic.splice(0, app.traffic.length - 600); renderCounts(); if (app.tab === 'traffic') scheduleTraffic(); }
const scheduleTraffic = debounce(() => app.tab === 'traffic' && renderPanel(), 120);

/* ---------- connection ---------- */
async function doConnect(target) {
  const old = app.conn; app.error = '';
  setPill('Connecting…', '');
  try {
    const t = target.kind === 'inpage' ? { kind: 'inpage', role: S.role } : target;
    const c = await connect(t, onLog, inpageOpts);
    if (t.kind === 'inpage') app.inpage = await getInpageServer(inpageOpts);
    app.cat = await c.listAll();
    if (old && old !== c) old.close().catch(() => {});
    app.conn = c; S.target = target.kind === 'inpage' ? { kind: 'inpage' } : { kind: 'remote', url: target.url, mode: target.mode || 'auto' }; saveSettings();
    renderHeader(); renderCounts(); renderPanel();
    return c;
  } catch (e) {
    app.error = e.message; renderHeader(); if (!app.conn) renderPanel(); throw e;
  }
}
function setPill(text, cls) { const p = $('#conn-pill'); p.textContent = text; p.className = 'pill ' + (cls || ''); }
function renderHeader() {
  const c = app.conn; const remote = c && c.target.kind === 'remote';
  if (!c) setPill(app.error ? 'Not connected' : 'Connecting…', '');
  else setPill(remote ? 'Remote: ' + new URL(c.target.url).host : 'Built-in server', 'ok');
  $('#role').value = S.role; $('#role').disabled = !!remote; $('#role').title = remote ? 'The remote server decides your role from its token' : 'Role of the built-in server token';
  const sr = $('#status-row');
  sr.innerHTML = c ? '<span class="pill ok">' + esc(c.server.name || 'server') + ' ' + esc(c.server.version || '') + '</span><span class="pill">protocol: ' + esc(c.era === 'modern' ? '2026-07-28 (stateless)' : 'legacy 2025-era') + '</span><span class="pill">' + (remote ? 'role: from token' : 'role: ' + esc(S.role)) + '</span><span class="pill">AI: ' + (S.mode === 'live' ? esc(LLM.PROVIDERS[S.provider].label) + (keyFor(S.provider) || !LLM.PROVIDERS[S.provider].needsKey ? '' : ' (no key yet)') : 'demo planner, no key') + '</span>'
    : app.error ? '<span class="pill">' + esc(app.error) + '</span> <button type="button" id="retry-inpage">Use the built-in server</button>' : '';
  const r = $('#retry-inpage'); if (r) r.onclick = () => doConnect({ kind: 'inpage' }).catch((e) => toast(e.message));
}
function renderCounts() {
  $('#c-tools').textContent = app.cat.tools.length || ''; $('#c-resources').textContent = (app.cat.resources.length + app.cat.templates.length) || '';
  $('#c-prompts').textContent = app.cat.prompts.length || ''; $('#c-traffic').textContent = app.traffic.length || '';
  $('#c-audit').textContent = app.inpage && isInpage() ? (app.inpage.audit.all().length || '') : '';
}
const isInpage = () => !!(app.conn && app.conn.target.kind === 'inpage');

/* ---------- tabs ---------- */
function setTab(t) { app.tab = t; $$('#tabs [role=tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === t))); renderPanel(); }
$('#tabs').addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b) setTab(b.dataset.tab); });
$('#tabs').addEventListener('keydown', (e) => { if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return; const bs = $$('#tabs [role=tab]'); const i = bs.findIndex((b) => b.dataset.tab === app.tab); const n = bs[(i + (e.key === 'ArrowRight' ? 1 : bs.length - 1)) % bs.length]; n.focus(); setTab(n.dataset.tab); });
function renderPanel() {
  const p = $('#panel');
  if (!app.conn) { p.innerHTML = '<div class="panel empty">' + (app.error ? esc(app.error) : 'Starting the built-in MCP server…') + '</div>'; return; }
  ({ agent: renderAgent, tools: renderTools, resources: renderResources, prompts: renderPrompts, traffic: renderTraffic, audit: renderAudit, setup: renderSetup })[app.tab](p);
}

/* ---------- agent ---------- */
function stepHtml(s) {
  const j = (x) => esc(JSON.stringify(x, null, 2));
  if (s.type === 'tool_call') return '<div class="step call">\u2192 ' + esc(s.name) + '(' + esc(JSON.stringify(s.args)) + ')' + (s.note ? ' <span class="muted">' + esc(s.note) + '</span>' : '') + '</div>';
  if (s.type === 'tool_result') {
    const r = s.result || {}; const sec = r.structuredContent && r.structuredContent.security; const flagged = sec && sec.injection_flags && sec.injection_flags.length;
    const text = (r.content || []).map((c) => c.text || (c.uri ? '[link] ' + c.uri : '')).join('\n');
    return (flagged ? '<div class="step flag">\u26a0 ' + esc(s.name) + ' returned text flagged as a possible prompt injection (' + esc(sec.injection_flags.map((f) => f.source + ': ' + f.kinds.join('/')).join(', ')) + '). The agent treats it as data.</div>' : '') +
      '<div class="step ' + (r.isError ? 'err' : 'ok') + '"><details><summary>\u2190 ' + esc(s.name) + (r.declined ? ' declined' : r.isError ? ' error' : ' ok') + (r.structuredContent && r.structuredContent.dry_run ? ' (dry run)' : '') + '</summary><pre>' + esc(text.slice(0, 4000)) + '</pre>' + (r.structuredContent ? '<pre>' + j(r.structuredContent).slice(0, 6000) + '</pre>' : '') + '</details></div>';
  }
  if (s.type === 'approval') return '<div class="step appr">' + (s.state === 'asked' ? '\u23f8 asked you to approve ' : s.state === 'approved' ? '\u2714 you approved ' : '\u2716 you declined ') + esc(s.name) + '</div>';
  if (s.type === 'thinking') return '<div class="step">' + esc(s.text.slice(0, 600)) + '</div>';
  return '';
}
function msgHtml(m) {
  if (m.role === 'user') return '<div class="msg user"><div class="who">You</div>' + esc(m.text) + '</div>';
  return '<div class="msg bot"><div class="who">' + esc(m.who || 'Agent') + '</div>' + (m.steps || []).map(stepHtml).join('') + (m.text ? '<div>' + md(m.text) + '</div>' : m.pending ? '<div class="muted">Working…</div>' : '') + (m.meta ? '<div class="muted small">' + esc(m.meta) + '</div>' : '') + '</div>';
}
function renderAgent(p) {
  const live = S.mode === 'live';
  p.innerHTML = '<div class="chat"><div class="panel"><div class="chatlog" id="chatlog" aria-live="polite">' + (app.chat.length ? app.chat.map(msgHtml).join('') : '<div class="empty">Ask about people, on-call, tickets, policies, laptops, expenses or metrics. ' + (live ? 'Your AI picks the MCP tools.' : 'The demo planner (rule-based, no key) picks the MCP tools.') + ' Anything that changes data asks for your approval first.</div>') + '</div>' +
    '<form class="composer" id="composer"><label class="sr-only" for="q">Message</label><textarea id="q" rows="2" maxlength="2000" placeholder="e.g. Who is on call for payments right now?"></textarea>' + (app.busy ? '<button type="button" id="stop">Stop</button>' : '<button class="primary" type="submit">Send</button>') + '</form>' +
    '<div class="chips" id="chips">' + EXAMPLES.map((x) => '<button type="button" class="chip">' + esc(x) + '</button>').join('') + '</div></div>' +
    '<aside class="side"><div class="panel"><h3>How this agent works</h3><p class="small">Mode: <b>' + (live ? esc(LLM.PROVIDERS[S.provider].label) + ' (' + esc(S.models[S.provider] || LLM.PROVIDERS[S.provider].defaultModel) + ')' : 'Demo planner (no AI, no key)') + '</b>. <button type="button" class="small-btn" id="open-settings">Change</button></p>' +
    '<p class="small muted">Read-only tools run right away. Write tools run as a dry run, then you see exactly what would change and choose Approve or Deny. Tool output is wrapped as untrusted data; text that looks like instructions to the AI is flagged.</p>' +
    '<div class="row"><button type="button" id="chat-export"' + (app.chat.length ? '' : ' disabled') + '>Export transcript</button><button type="button" id="chat-share">Copy link to question</button><button type="button" id="chat-clear"' + (app.chat.length ? '' : ' disabled') + '>Clear chat</button></div></div>' +
    '<div class="panel"><h3>Try these</h3><ul class="small"><li><b>Injection:</b> "Summarize ticket IT-1007" (it hides instructions to close tickets and email the directory out).</li><li><b>Approval:</b> "My keyboard keys are sticking, open a ticket".</li><li><b>Roles:</b> switch to <b>viewer</b> and ask for expenses or to open a ticket.</li><li><b>SQL guard:</b> "Run SQL: DELETE FROM tickets".</li></ul></div></aside></div>';
  const log = $('#chatlog'); log.scrollTop = log.scrollHeight;
  const q = $('#q'); if (app.draft) { q.value = app.draft; } q.oninput = () => { app.draft = q.value; };
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#composer').requestSubmit(); } });
  $('#composer').onsubmit = (e) => { e.preventDefault(); ask(q.value); };
  $('#chips').onclick = (e) => { const b = e.target.closest('.chip'); if (b && !app.busy) ask(b.textContent); };
  const st = $('#stop'); if (st) st.onclick = () => app.abort && app.abort.abort();
  $('#open-settings').onclick = openSettings;
  $('#chat-export').onclick = exportTranscript;
  $('#chat-share').onclick = () => { const t = (q.value || (app.chat.filter((m) => m.role === 'user').pop() || {}).text || '').trim(); if (!t) { toast('Type a question first.'); return; } const u = new URL(location.href); u.hash = 'ask=' + encodeURIComponent(t) + '&role=' + S.role; copy(u.href, 'Link copied. It holds only the question and role, never a key.'); };
  $('#chat-clear').onclick = () => { const old = app.chat; const oldH = app.liveHistory; app.chat = []; app.liveHistory = []; renderPanel(); toast('Chat cleared.', () => { app.chat = old; app.liveHistory = oldH; renderPanel(); }); };
}
function refreshChat() { if (app.tab !== 'agent') return; const log = $('#chatlog'); if (!log) return; log.innerHTML = app.chat.map(msgHtml).join(''); log.scrollTop = log.scrollHeight; }
async function ask(text) {
  const qtext = String(text || '').trim(); if (!qtext || app.busy) return;
  if (!app.conn) { toast('Not connected to a server.'); return; }
  const live = S.mode === 'live'; const prov = LLM.PROVIDERS[S.provider];
  if (live && prov.needsKey && !keyFor(S.provider)) { toast('Add your ' + prov.label + ' key in AI settings, or switch to the demo planner.'); openSettings(); return; }
  app.draft = ''; app.busy = true; app.abort = new AbortController();
  app.chat.push({ role: 'user', text: qtext });
  const bot = { role: 'bot', who: live ? prov.label : 'Demo planner', steps: [], pending: true }; app.chat.push(bot);
  renderPanel();
  const ctx = { tools: app.cat.tools, callTool: (n, a) => app.conn.callTool(n, a), approve: approvalPrompt, emit: (s) => { bot.steps.push(s); refreshChat(); } };
  try {
    if (!live) { bot.text = await runDemoAgent({ ctx, question: qtext }); }
    else {
      const cfg = { provider: S.provider, model: S.models[S.provider] || prov.defaultModel, key: keyFor(S.provider), baseUrl: S.provider === 'compatible' ? (S.baseUrl || prov.baseUrl) : '' };
      const r = await runLiveAgent({ llm: (msg) => LLM.call(cfg, msg, { signal: app.abort.signal }), ctx, question: qtext, history: app.liveHistory.slice(-12), instructions: app.conn.instructions, secrets: [cfg.key], signal: app.abort.signal });
      bot.text = r.answer; app.liveHistory.push({ role: 'user', content: qtext }, { role: 'assistant', content: r.answer });
      bot.meta = r.usage.calls + ' model call' + (r.usage.calls === 1 ? '' : 's') + ', ' + r.usage.input + ' in / ' + r.usage.output + ' out tokens' + (r.usage.cost ? ', about $' + r.usage.cost.toFixed(4) : '');
    }
  } catch (e) { bot.text = '**Error:** ' + (e && e.message || String(e)); }
  finally { bot.pending = false; app.busy = false; app.abort = null; if (app.tab === 'agent') renderPanel(); }
}
function approvalPrompt({ tool, args, preview }) {
  return new Promise((resolve) => {
    let decided = false;
    const sc = preview && preview.structuredContent; const text = preview ? (preview.content || []).map((c) => c.text || '').join('\n') : '';
    const html = '<div class="callout warn"><b>' + esc(tool.title || tool.name) + '</b> wants to change data' + (tool.annotations && tool.annotations.destructiveHint ? ' (it can overwrite existing records)' : '') + '. Nothing has changed yet.</div>' +
      (text ? '<h3 style="font-size:14px">Dry-run preview</h3><pre class="json">' + esc(text.split('\n')[0]) + '</pre>' : '') + (sc && sc.changes && sc.changes.length ? '<table class="audit"><thead><tr><th>Field</th><th>From</th><th>To</th></tr></thead><tbody>' + sc.changes.map((c) => '<tr><td>' + esc(c.field) + '</td><td>' + esc(JSON.stringify(c.from)) + '</td><td>' + esc(JSON.stringify(c.to)) + '</td></tr>').join('') + '</tbody></table>' : '') + (sc && sc.ticket ? '<details' + (sc.changes ? '' : ' open') + '><summary>Ticket after the change</summary><pre class="json">' + esc(JSON.stringify(sc.ticket, null, 2)) + '</pre></details>' : '') +
      '<details><summary>Exact arguments</summary><pre class="json">' + esc(JSON.stringify(Object.assign({}, args, { confirm: true }), null, 2)) + '</pre></details><p class="muted small">Approve runs it for real with confirm=true. Deny, Esc, X, clicking outside or Back all count as Deny.</p>';
    openModal('Approve ' + tool.name + '?', html, { name: 'approval', save: () => { decided = true; closeModal(true, 'approved'); }, saveLabel: 'Approve', cancelLabel: 'Deny', wide: true, onClose: (reason) => resolve(decided && reason === 'approved') });
  });
}
function exportTranscript() {
  const lines = ['# ToolBridge MCP agent transcript', '', 'Server: ' + (app.conn.server.name || '') + ' ' + (app.conn.server.version || '') + (isInpage() ? ' (built-in, role ' + S.role + ')' : ' (' + app.conn.target.url + ')'), 'Mode: ' + (S.mode === 'live' ? LLM.PROVIDERS[S.provider].label + ' ' + (S.models[S.provider] || LLM.PROVIDERS[S.provider].defaultModel) : 'demo planner'), 'Exported: ' + new Date().toISOString(), ''];
  for (const m of app.chat) {
    if (m.role === 'user') { lines.push('## You', '', m.text, ''); continue; }
    lines.push('## ' + (m.who || 'Agent'), '');
    for (const s of m.steps || []) { if (s.type === 'tool_call') lines.push('- call `' + s.name + '` ' + JSON.stringify(s.args)); else if (s.type === 'tool_result') lines.push('- result `' + s.name + '`: ' + (s.result.isError ? 'error' : 'ok') + (s.result.structuredContent && s.result.structuredContent.security && s.result.structuredContent.security.injection_flags.length ? ' (injection flagged)' : '')); else if (s.type === 'approval') lines.push('- approval ' + s.state + ' for `' + s.name + '`'); }
    lines.push('', m.text || '', '');
  }
  const secrets = Object.values(memKeys).concat(Object.values(keys)).filter((k) => k && k.length >= 6);
  let out = lines.join('\n'); secrets.forEach((k) => { out = out.split(k).join('[REDACTED]'); });
  download('toolbridge-transcript.md', out, 'text/markdown');
}

/* ---------- tools ---------- */
function badges(t) {
  const a = t.annotations || {}; const meta = t._meta || {}; const b = [];
  b.push(a.readOnlyHint ? '<span class="badge ro">read-only</span>' : '<span class="badge write">writes</span>');
  if (a.destructiveHint && !a.readOnlyHint) b.push('<span class="badge destr">destructive</span>');
  if (a.idempotentHint) b.push('<span class="badge">idempotent</span>');
  if (a.openWorldHint) b.push('<span class="badge">open world</span>');
  const role = meta['toolbridge/minRole'] || meta.minRole; if (role) b.push('<span class="badge lock">min role: ' + esc(role) + '</span>');
  if (t.outputSchema) b.push('<span class="badge">structured output</span>');
  return '<div class="badges">' + b.join('') + '</div>';
}
function renderTools(p) {
  p.innerHTML = '<div class="panel"><div class="row"><label class="sr-only" for="tool-filter">Filter tools</label><input id="tool-filter" placeholder="Filter tools" style="max-width:320px" value="' + esc(app.toolFilter || '') + '"><span class="spacer"></span><button type="button" id="cat-export">Export catalog JSON</button>' + (isInpage() ? '<button type="button" id="reset-data">Reset demo data</button>' : '') + '</div>' +
    '<p class="muted small">From <code>tools/list</code>. Click Run to call a tool through the MCP client; write tools default to a dry run. Your role: <b>' + (isInpage() ? esc(S.role) : 'set by the remote token') + '</b>.</p><div class="grid" id="tool-grid"></div></div>';
  const draw = () => { const f = (app.toolFilter || '').toLowerCase(); $('#tool-grid').innerHTML = app.cat.tools.filter((t) => !f || (t.name + ' ' + (t.title || '') + ' ' + (t.description || '')).toLowerCase().includes(f)).map((t) => '<div class="card"><h3>' + esc(t.name) + '</h3>' + badges(t) + '<p>' + esc((t.description || '').split('\n')[0].slice(0, 220)) + '</p><div class="row"><button type="button" class="primary" data-run="' + esc(t.name) + '">Run…</button><button type="button" data-schema="' + esc(t.name) + '">Schema</button></div></div>').join('') || '<div class="empty">No tools match.</div>'; };
  draw();
  $('#tool-filter').oninput = (e) => { app.toolFilter = e.target.value; draw(); };
  $('#tool-grid').onclick = (e) => { const r = e.target.closest('[data-run]'); const s = e.target.closest('[data-schema]'); if (r) openTool(r.dataset.run); if (s) openSchema(s.dataset.schema); };
  $('#cat-export').onclick = () => download('toolbridge-catalog.json', JSON.stringify({ server: app.conn.server, protocol: app.conn.era, ...app.cat }, null, 2), 'application/json');
  const rd = $('#reset-data'); if (rd) rd.onclick = resetData;
}
function resetData() {
  const st = app.inpage.store; const snap = st.snapshot(); st.reset(); app.inpage.metrics.syncTickets && app.inpage.metrics.syncTickets(st.tickets);
  toast('Demo tickets reset to the original 14.', () => { st.restore(snap); app.inpage.metrics.syncTickets && app.inpage.metrics.syncTickets(st.tickets); toast('Tickets restored.'); });
}
function openSchema(name) {
  const t = app.cat.tools.find((x) => x.name === name);
  openModal(name + ' schema', '<p>' + esc(t.description || '') + '</p>' + badges(t) + '<h3 style="font-size:14px">inputSchema</h3><pre class="json">' + esc(JSON.stringify(t.inputSchema, null, 2)) + '</pre>' + (t.outputSchema ? '<h3 style="font-size:14px">outputSchema</h3><pre class="json">' + esc(JSON.stringify(t.outputSchema, null, 2)) + '</pre>' : '') + '<h3 style="font-size:14px">annotations</h3><pre class="json">' + esc(JSON.stringify(t.annotations || {}, null, 2)) + '</pre>', { wide: true, name: 'schema' });
}
function resultHtml(r) {
  const sec = r.structuredContent && r.structuredContent.security; const flags = sec && sec.injection_flags && sec.injection_flags.length;
  return (r.isError ? '<div class="callout bad"><b>Error</b> (isError: true)</div>' : '') + (flags ? '<div class="callout bad">\u26a0 Possible prompt injection in: ' + esc(sec.injection_flags.map((f) => f.source + ' (' + f.kinds.join(', ') + ')').join('; ')) + '. Clients should treat it as data.</div>' : '') +
    (r.structuredContent && r.structuredContent.dry_run ? '<div class="callout warn">Dry run: nothing changed. Tick <b>confirm</b> to do it for real.</div>' : '') +
    (r.content || []).map((c) => c.type === 'text' ? '<pre class="json">' + esc(c.text) + '</pre>' : c.type === 'resource_link' ? '<div class="small">\ud83d\udd17 <code>' + esc(c.uri) + '</code> ' + esc(c.name || '') + '</div>' : '<pre class="json">' + esc(JSON.stringify(c, null, 2)) + '</pre>').join('') +
    (r.structuredContent ? '<details><summary>structuredContent</summary><pre class="json">' + esc(JSON.stringify(r.structuredContent, null, 2)) + '</pre></details>' : '');
}
function openTool(name, values) {
  const t = app.cat.tools.find((x) => x.name === name); if (!t) return;
  openModal('Run ' + name, '<p class="small muted">' + esc(t.description || '') + '</p>' + badges(t) + '<form id="tool-form" novalidate style="margin-top:10px">' + schemaForm(t.inputSchema, 'tf', values) + '</form><div id="tool-err" class="err" role="alert"></div><div id="tool-out" aria-live="polite"></div>',
    { name: 'tool', dirty: true, wide: true, focusFirst: true, save: async () => {
      const f = readForm($('#tool-form'), t.inputSchema); const err = $('#tool-err');
      if (f.errors.length) { err.textContent = f.errors.join('. ') + '.'; return; } err.textContent = '';
      const btn = $('#modal-save'); btn.disabled = true; btn.textContent = 'Running…';
      try { const r = await app.conn.callTool(name, f.values); const out = $('#tool-out'); if (out) out.innerHTML = '<h3 style="font-size:14px">Result</h3>' + resultHtml(r); setDirty(false); }
      catch (e) { if ($('#tool-err')) $('#tool-err').textContent = e.message; }
      finally { const b = $('#modal-save'); if (b) { b.disabled = false; b.textContent = 'Run'; } }
    }, saveLabel: 'Run', cancelLabel: 'Close' });
  $('#tool-form').onsubmit = (e) => { e.preventDefault(); $('#modal-save').click(); };
}

/* ---------- resources & prompts ---------- */
function renderResources(p) {
  p.innerHTML = '<div class="panel"><p class="muted small">From <code>resources/list</code> and <code>resources/templates/list</code>. Wiki pages and tickets are user-written content; flagged text gets a warning header.</p><h3>Resources</h3><div class="grid">' + app.cat.resources.map((r) => '<div class="card"><h3>' + esc(r.uri) + '</h3><p>' + esc(r.title || r.name || '') + (r.description ? ': ' + esc(r.description) : '') + '</p><div class="row"><button type="button" data-read="' + esc(r.uri) + '">Read</button><span class="muted small">' + esc(r.mimeType || '') + '</span></div></div>').join('') + '</div>' +
    '<h3>Templates</h3><div class="grid">' + app.cat.templates.map((r, i) => '<div class="card"><h3>' + esc(r.uriTemplate) + '</h3><p>' + esc(r.title || r.name || '') + (r.description ? ': ' + esc(r.description) : '') + '</p><div class="row"><button type="button" data-tpl="' + i + '">Open…</button></div></div>').join('') + '</div></div>';
  p.onclick = (e) => { const r = e.target.closest('[data-read]'); const t = e.target.closest('[data-tpl]'); if (r) readRes(r.dataset.read); if (t) openTemplate(app.cat.templates[+t.dataset.tpl]); };
}
async function readRes(uri) {
  try { const r = await app.conn.readResource(uri); openModal(uri, r.contents.map((c) => '<div class="muted small">' + esc(c.uri) + ' \u00b7 ' + esc(c.mimeType || '') + '</div><pre class="json">' + esc(c.text != null ? c.text : '[binary ' + (c.blob || '').length + ' chars base64]') + '</pre>').join(''), { wide: true, name: 'resource' }); }
  catch (e) { toast(e.message); }
}
function openTemplate(tpl) {
  const vars = Array.from(tpl.uriTemplate.matchAll(/\{([^}]+)\}/g)).map((m) => m[1]);
  const hints = { slug: 'pto-policy, expense-policy, remote-work, it-security-basics…', id: 'IT-1007' };
  openModal(tpl.uriTemplate, '<form id="tpl-form">' + vars.map((v) => '<div class="field"><label for="tv-' + v + '">' + esc(v) + ' <span class="req">*</span></label><input id="tv-' + v + '" data-v="' + esc(v) + '" placeholder="' + esc(hints[v] || '') + '"></div>').join('') + '</form><div class="err" id="tpl-err"></div>',
    { name: 'template', dirty: true, focusFirst: true, saveLabel: 'Read', save: () => { let uri = tpl.uriTemplate; let miss = false; $$('#tpl-form [data-v]').forEach((el) => { if (!el.value.trim()) miss = true; uri = uri.replace('{' + el.dataset.v + '}', encodeURIComponent(el.value.trim())); }); if (miss) { $('#tpl-err').textContent = 'Fill in every value.'; return; } closeModal(true); setTimeout(() => readRes(uri), 60); } });
  $('#tpl-form').onsubmit = (e) => { e.preventDefault(); $('#modal-save').click(); };
}
function renderPrompts(p) {
  p.innerHTML = '<div class="panel"><p class="muted small">From <code>prompts/list</code>. A prompt returns ready-made messages a client can send to its model.</p><div class="grid">' + app.cat.prompts.map((x) => '<div class="card"><h3>' + esc(x.name) + '</h3><p>' + esc(x.description || '') + '</p><p class="small">Arguments: ' + ((x.arguments || []).map((a) => esc(a.name) + (a.required ? '*' : '')).join(', ') || 'none') + '</p><div class="row"><button type="button" data-prompt="' + esc(x.name) + '">Get…</button></div></div>').join('') + '</div></div>';
  p.onclick = (e) => { const b = e.target.closest('[data-prompt]'); if (b) openPrompt(app.cat.prompts.find((x) => x.name === b.dataset.prompt)); };
}
function openPrompt(pr) {
  const schema = { type: 'object', properties: Object.fromEntries((pr.arguments || []).map((a) => [a.name, { type: 'string', description: a.description }])), required: (pr.arguments || []).filter((a) => a.required).map((a) => a.name) };
  openModal('Prompt ' + pr.name, '<form id="pr-form">' + schemaForm(schema, 'pa') + '</form><div class="err" id="pr-err"></div><div id="pr-out"></div>', { name: 'prompt', dirty: true, wide: true, focusFirst: true, saveLabel: 'Get prompt', cancelLabel: 'Close', save: async () => {
    const f = readForm($('#pr-form'), schema); if (f.errors.length) { $('#pr-err').textContent = f.errors.join('. ') + '.'; return; } $('#pr-err').textContent = '';
    try { const r = await app.conn.getPrompt(pr.name, f.values); $('#pr-out').innerHTML = '<p class="small muted">' + esc(r.description || '') + '</p>' + r.messages.map((m) => '<div class="muted small">' + esc(m.role) + ' \u00b7 ' + esc(m.content.type) + '</div><pre class="json">' + esc(m.content.type === 'text' ? m.content.text : m.content.type === 'resource' ? m.content.resource.uri + '\n' + (m.content.resource.text || '') : JSON.stringify(m.content, null, 2)) + '</pre>').join(''); setDirty(false); }
    catch (e) { $('#pr-err').textContent = e.message; }
  } });
  $('#pr-form').onsubmit = (e) => { e.preventDefault(); $('#modal-save').click(); };
}

/* ---------- traffic ---------- */
function rpcLabel(m) {
  if (!m) return ''; if (typeof m === 'string') return m;
  const one = (x) => x.method ? x.method + (x.params && x.params.name ? ' ' + x.params.name : x.params && x.params.uri ? ' ' + x.params.uri : '') + (x.id != null ? ' #' + x.id : ' (notification)') : x.error ? 'error #' + x.id + ': ' + (x.error.message || '').slice(0, 80) : x.result ? 'result #' + x.id + (x.result.isError ? ' (isError)' : '') : '';
  return Array.isArray(m) ? m.map(one).join(', ') : one(m);
}
function renderTraffic(p) {
  const f = (app.trafficFilter || '').toLowerCase();
  const rows = app.traffic.filter((e) => !f || JSON.stringify(e).toLowerCase().includes(f)).slice(-200).reverse();
  p.innerHTML = '<div class="panel"><div class="row"><label class="sr-only" for="tr-filter">Filter</label><input id="tr-filter" placeholder="Filter (e.g. tools/call)" style="max-width:300px" value="' + esc(app.trafficFilter || '') + '"><span class="spacer"></span><button type="button" id="tr-export"' + (app.traffic.length ? '' : ' disabled') + '>Export JSON</button><button type="button" id="tr-clear"' + (app.traffic.length ? '' : ' disabled') + '>Clear</button></div>' +
    '<p class="muted small">Every HTTP request and JSON-RPC message between the MCP client and ' + (isInpage() ? 'the built-in server (' + esc(INPAGE_URL) + ', handled inside this page)' : esc(app.conn.target.url)) + '. Newest first; Authorization values are masked.</p><div class="log">' +
    (rows.length ? rows.map((e) => '<details class="logrow"><summary><span class="dir ' + e.dir + '">' + (e.dir === 'out' ? '\u2192' : '\u2190') + '</span><span>' + esc(e.http) + (e.dir === 'in' ? ' ' + esc(e.status) : '') + '</span><span>' + esc(rpcLabel(e.msg) || e.error || '') + '</span>' + (e.ms != null ? '<span class="muted">' + e.ms + ' ms</span>' : '') + '</summary><pre class="json">' + esc(JSON.stringify(e.dir === 'out' ? { url: e.url, headers: e.headers, body: e.msg } : e.error ? { error: e.error } : e.msg, null, 2)) + '</pre></details>').join('') : '<div class="empty">No traffic yet. Run a tool or ask the agent something.</div>') + '</div></div>';
  $('#tr-filter').oninput = (e) => { app.trafficFilter = e.target.value; const pos = e.target.selectionStart; renderTraffic(p); const i = $('#tr-filter'); i.focus(); i.setSelectionRange(pos, pos); };
  $('#tr-export').onclick = () => download('toolbridge-jsonrpc.json', JSON.stringify(app.traffic, null, 2), 'application/json');
  $('#tr-clear').onclick = () => { const old = app.traffic; app.traffic = []; renderCounts(); renderPanel(); toast('Traffic log cleared.', () => { app.traffic = old.concat(app.traffic); renderCounts(); renderPanel(); }); };
}

/* ---------- audit ---------- */
function renderAudit(p) {
  if (!isInpage()) { p.innerHTML = '<div class="panel"><div class="callout">The audit log lives on the server you connected to (by default <code>~/.toolbridge-mcp/audit.jsonl</code>, redacted JSONL). An <b>admin</b> token can read recent entries with the <code>audit_recent</code> tool.</div></div>'; return; }
  const a = app.inpage.audit; const f = app.auditOutcome || '';
  const rows = a.all().slice().reverse().filter((x) => !f || x.outcome === f);
  const outcomes = ['ok', 'dry_run', 'denied', 'rate_limited', 'invalid', 'error', 'unauthorized'];
  p.innerHTML = '<div class="panel"><div class="row"><label for="au-f" class="small">Outcome</label><select id="au-f" style="width:auto"><option value="">all</option>' + outcomes.map((o) => '<option' + (o === f ? ' selected' : '') + '>' + o + '</option>').join('') + '</select><span class="spacer"></span><button type="button" id="au-export"' + (a.all().length ? '' : ' disabled') + '>Export JSONL</button><button type="button" id="au-clear"' + (a.all().length ? '' : ' disabled') + '>Clear</button></div>' +
    '<p class="muted small">What the server recorded: who called what, with secrets, emails, phones and salary data redacted. The Node server appends the same lines to a JSONL file. Kept in this browser (last 400).</p>' +
    (rows.length ? '<div class="tablewrap"><table class="audit"><thead><tr><th>Time (UTC)</th><th>Who</th><th>What</th><th>Outcome</th><th>Args</th></tr></thead><tbody>' + rows.slice(0, 300).map((x) => '<tr><td>' + esc((x.ts || '').slice(11, 19)) + '</td><td>' + esc(x.principal) + '<br><span class="muted">' + esc(x.role) + '</span></td><td>' + esc(x.kind || 'tool') + ' <b>' + esc(x.name) + '</b></td><td><span class="outcome ' + esc(x.outcome) + '">' + esc(x.outcome) + '</span>' + (x.reason ? '<br><span class="muted small">' + esc(String(x.reason).slice(0, 120)) + '</span>' : '') + (x.flags ? '<br><span class="outcome error">injection flagged</span>' : '') + '</td><td class="args">' + esc(x.args ? JSON.stringify(x.args).slice(0, 300) : '') + '</td></tr>').join('') + '</tbody></table></div>' : '<div class="empty">No audit entries' + (f ? ' with that outcome' : '') + '.</div>') + '</div>';
  $('#au-f').onchange = (e) => { app.auditOutcome = e.target.value; renderAudit(p); };
  $('#au-export').onclick = () => download('toolbridge-audit.jsonl', a.toJsonl(), 'application/x-ndjson');
  $('#au-clear').onclick = () => { const old = a.clear(); persistAudit(); renderCounts(); renderAudit(p); toast('Audit log cleared.', () => { a.load(old.concat(a.all())); persistAudit(); renderCounts(); if (app.tab === 'audit') renderPanel(); }); };
}

/* ---------- setup ---------- */
function renderSetup(p) {
  const sn = (k, label, note) => '<div class="panel"><h3>' + esc(label) + '</h3><p class="small muted">' + esc(SNIPPETS[k].file) + (note ? ' \u00b7 ' + note : '') + '</p><div class="snippet"><pre class="json">' + esc(JSON.stringify(SNIPPETS[k].json, null, 2)) + '</pre><button type="button" class="small-btn" data-copy="' + k + '">Copy</button></div></div>';
  p.innerHTML = '<div class="panel"><h3>Run the server</h3><p class="small">Needs Node 20.19+. Data is fictional and stored in <code>~/.toolbridge-mcp</code>.</p><div class="snippet"><pre class="json">' + esc('# stdio (what desktop clients launch)\nnpx -y github:shaikbasha1437/toolbridge-mcp stdio --role agent\n\n# Streamable HTTP on 127.0.0.1:8787 with throwaway tokens, allowing this playground\nnpx -y github:shaikbasha1437/toolbridge-mcp http --dev-tokens --playground\n\n# real tokens: generate, then pass via env\nnpx -y github:shaikbasha1437/toolbridge-mcp token agent\nTOOLBRIDGE_TOKENS="agent:tb_agent_..." npx -y github:shaikbasha1437/toolbridge-mcp http') + '</pre><button type="button" class="small-btn" data-copy="run">Copy</button></div>' +
    '<p class="small">Then press <b>Connect…</b> above, choose <b>Remote server</b>, enter <code>http://127.0.0.1:8787/mcp</code> and a token the server printed. Chrome and Edge may ask to allow this site to access devices on your local network; allow it. Safari may block http://localhost from an https page entirely; use the CLI or Inspector there.</p></div>' +
    '<div class="grid">' + sn('claude', 'Claude Desktop', 'tested with the same stdio command via the MCP Inspector CLI, not inside the Claude app') + sn('cursor', 'Cursor', 'documented') + sn('vscode', 'VS Code (Copilot agent mode)', 'documented') + sn('http', 'Remote HTTP clients', 'tested with the Inspector CLI and this page') + '</div>' +
    '<div class="panel"><h3>Inspect it</h3><div class="snippet"><pre class="json">npx @modelcontextprotocol/inspector --cli npx -y github:shaikbasha1437/toolbridge-mcp stdio --method tools/list</pre><button type="button" class="small-btn" data-copy="insp">Copy</button></div></div>';
  const texts = { run: $('pre', p).textContent, insp: 'npx @modelcontextprotocol/inspector --cli npx -y github:shaikbasha1437/toolbridge-mcp stdio --method tools/list' };
  p.onclick = (e) => { const b = e.target.closest('[data-copy]'); if (!b) return; const k = b.dataset.copy; copy(texts[k] || JSON.stringify(SNIPPETS[k].json, null, 2), 'Copied.'); };
}
function copy(text, msg) { (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject(new Error('no clipboard'))).then(() => toast(msg || 'Copied.')).catch(() => { prompt('Copy this:', text); }); }

/* ---------- settings ---------- */
function openSettings() {
  const prov = S.provider;
  const html = '<fieldset class="field" style="border:0;padding:0"><legend class="lbl">Agent mode</legend><label class="chk"><input type="radio" name="st-mode" value="demo"' + (S.mode === 'demo' ? ' checked' : '') + '> <span><b>Demo planner</b>: rule-based, no key, works offline.</span></label><label class="chk"><input type="radio" name="st-mode" value="live"' + (S.mode === 'live' ? ' checked' : '') + '> <span><b>Live AI</b>: your own key, real function calling.</span></label></fieldset>' +
    '<div id="st-live"><div class="field"><label for="st-prov">Provider</label><select id="st-prov">' + Object.entries(LLM.PROVIDERS).map(([k, v]) => '<option value="' + k + '"' + (k === prov ? ' selected' : '') + '>' + esc(v.label) + '</option>').join('') + '</select></div><div id="st-prov-body"></div></div>' +
    '<label class="chk"><input type="checkbox" id="st-remember"' + (S.remember ? ' checked' : '') + '> <span>Remember keys on this device (localStorage). Off: keys are kept only until you close this tab.</span></label>' +
    '<div class="callout small">Keys go only from this browser to the provider you pick. They are never sent to an MCP server, never put in prompts, transcripts, exports or share links. Use a key with a spending limit.</div><div class="row"><button type="button" id="st-forget" class="danger">Forget all saved keys</button></div><div class="err" id="st-err"></div>';
  const draft = { keys: {}, models: Object.assign({}, S.models), baseUrl: S.baseUrl };
  const drawProv = () => {
    const k = $('#st-prov').value; const p = LLM.PROVIDERS[k];
    $('#st-prov-body').innerHTML = (k === 'compatible' ? '<div class="field"><label for="st-base">Base URL</label><input id="st-base" value="' + esc(draft.baseUrl || p.baseUrl) + '" placeholder="' + esc(p.baseUrl) + '"><div class="chips">' + LLM.PRESETS.map((x) => '<button type="button" class="chip" data-preset="' + x.id + '">' + esc(x.label) + '</button>').join('') + '</div></div>' : '') +
      '<div class="field"><label for="st-model">Model</label><input id="st-model" list="st-models" value="' + esc(draft.models[k] || p.defaultModel) + '"><datalist id="st-models">' + p.models.map((m) => '<option value="' + esc(m) + '">').join('') + '</datalist></div>' +
      '<div class="field"><label for="st-key">' + esc(p.label) + ' API key' + (p.needsKey ? '' : ' (optional)') + '</label><input id="st-key" type="password" autocomplete="off" spellcheck="false" placeholder="' + (keyFor(k) ? 'saved (leave blank to keep)' : esc(p.keyHint)) + '" value="' + esc(draft.keys[k] || '') + '">' + (p.keyUrl ? '<div class="help">Get one at <a href="' + p.keyUrl + '" target="_blank" rel="noopener">' + esc(new URL(p.keyUrl).host) + '</a>.' + (k === 'anthropic' ? ' Sent with the anthropic-dangerous-direct-browser-access header, which Anthropic requires for browser calls.' : '') + '</div>' : '<div class="help">For Ollama set OLLAMA_ORIGINS to include ' + esc(location.origin) + '.</div>') + '</div>';
    $('#st-model').oninput = (e) => { draft.models[k] = e.target.value.trim(); };
    $('#st-key').oninput = (e) => { draft.keys[k] = e.target.value.trim(); };
    const b = $('#st-base'); if (b) b.oninput = (e) => { draft.baseUrl = e.target.value.trim(); };
    $$('[data-preset]').forEach((c) => (c.onclick = () => { const x = LLM.PRESETS.find((y) => y.id === c.dataset.preset); draft.baseUrl = x.baseUrl; draft.models.compatible = x.model; setDirty(true); drawProv(); }));
  };
  openModal('AI settings', html, { name: 'settings', dirty: true, save: () => {
    const mode = ($('input[name=st-mode]:checked') || {}).value || 'demo'; const k = $('#st-prov').value;
    if (draft.baseUrl && !/^https?:\/\//i.test(draft.baseUrl)) { $('#st-err').textContent = 'Base URL must start with http:// or https://'; return; }
    S.mode = mode; S.provider = k; S.models = draft.models; S.baseUrl = draft.baseUrl; S.remember = $('#st-remember').checked;
    Object.entries(draft.keys).forEach(([p, v]) => { if (v) memKeys[p] = v; });
    if (S.remember) { keys = Object.assign({}, keys, memKeys); LS.set('tb.keys', keys); } else { keys = {}; LS.del('tb.keys'); }
    saveSettings(); closeModal(true); renderHeader(); renderPanel();
    toast(mode === 'live' ? 'Live mode: ' + LLM.PROVIDERS[k].label + (keyFor(k) || !LLM.PROVIDERS[k].needsKey ? '' : '. Add a key to chat.') : 'Demo planner mode (no key).');
  } });
  drawProv();
  $('#st-prov').onchange = drawProv;
  $('#st-forget').onclick = () => { Object.keys(memKeys).forEach((k) => delete memKeys[k]); keys = {}; LS.del('tb.keys'); draft.keys = {}; drawProv(); toast('Saved keys removed from this browser.'); renderHeader(); };
}

/* ---------- connect ---------- */
function openConnect() {
  const cur = app.conn && app.conn.target.kind === 'remote' ? app.conn.target : null;
  const savedList = () => S.saved.length ? S.saved.map((s, i) => '<div class="row" style="justify-content:space-between;border-bottom:1px solid var(--line);padding:6px 0"><span class="mono small" style="overflow-wrap:anywhere;min-width:0;flex:1">' + esc(s.url) + '</span><button type="button" class="small-btn" data-use="' + i + '">Use</button><button type="button" class="small-btn danger" data-del="' + i + '" aria-label="Delete ' + esc(s.url) + '">Delete</button></div>').join('') : '<p class="muted small">None yet. Servers you connect to are listed here (tokens only if you tick remember).</p>';
  const html = '<fieldset class="field" style="border:0;padding:0"><legend class="lbl">Server</legend><label class="chk"><input type="radio" name="cn-kind" value="inpage"' + (cur ? '' : ' checked') + '> <span><b>Built-in</b>: the ToolBridge server running inside this page (no install).</span></label><label class="chk"><input type="radio" name="cn-kind" value="remote"' + (cur ? ' checked' : '') + '> <span><b>Remote server</b>: Streamable HTTP, e.g. your local <code>toolbridge-mcp http</code>, or a public server that allows CORS.</span></label></fieldset>' +
    '<div id="cn-remote"><div class="field"><label for="cn-url">Server URL <span class="req">*</span></label><input id="cn-url" type="url" placeholder="http://127.0.0.1:8787/mcp" value="' + esc(cur ? cur.url : '') + '"></div>' +
    '<div class="field"><label for="cn-token">Bearer token</label><input id="cn-token" type="password" autocomplete="off" spellcheck="false" placeholder="tb_agent_… (printed by the server)" value=""><div class="help">Sent only to that server, in the Authorization header.</div></div>' +
    '<div class="field"><label for="cn-mode">Protocol</label><select id="cn-mode"><option value="auto">Auto (2026-07-28 stateless, falls back to 2025-era)</option><option value="legacy">Legacy only (2025-era initialize handshake)</option></select></div>' +
    '<label class="chk"><input type="checkbox" id="cn-remember"> <span>Remember this token on this device</span></label>' +
    '<div class="callout small">Local servers: start with <code>--playground</code> so it accepts this site. Your browser may ask to allow access to your local network.</div><h3 style="font-size:14px">Saved servers</h3><div id="cn-saved">' + savedList() + '</div></div><div class="err" id="cn-err" role="alert"></div>';
  openModal('Connect to an MCP server', html, { name: 'connect', dirty: true, saveLabel: 'Connect', save: async () => {
    const kind = $('input[name=cn-kind]:checked').value; const err = $('#cn-err'); err.textContent = '';
    if (kind === 'inpage') { try { await doConnect({ kind: 'inpage' }); closeModal(true); toast('Connected to the built-in server.'); } catch (e) { err.textContent = e.message; } return; }
    const url = $('#cn-url').value.trim(); const token = $('#cn-token').value.trim() || memTokens[url] || savedTokens[url] || ''; const mode = $('#cn-mode').value;
    if (!url) { err.textContent = 'Enter the server URL (or choose Built-in).'; $('#cn-url').focus(); return; }
    const btn = $('#modal-save'); btn.disabled = true; btn.textContent = 'Connecting…';
    try {
      await doConnect({ kind: 'remote', url, token, mode });
      if (token) memTokens[url] = token;
      if ($('#cn-remember').checked && token) { savedTokens[url] = token; LS.set('tb.tokens', savedTokens); }
      if (!S.saved.some((s) => s.url === url)) { S.saved.unshift({ url, mode }); S.saved = S.saved.slice(0, 8); saveSettings(); }
      closeModal(true); toast('Connected to ' + new URL(url).host + ' (' + (app.conn.era === 'modern' ? '2026-07-28' : 'legacy') + ').');
    } catch (e) { if ($('#cn-err')) $('#cn-err').textContent = e.message; }
    finally { const b = $('#modal-save'); if (b) { b.disabled = false; b.textContent = 'Connect'; } }
  } });
  const sync = () => { $('#cn-remote').style.display = $('input[name=cn-kind]:checked').value === 'remote' ? '' : 'none'; };
  $$('input[name=cn-kind]').forEach((r) => (r.onchange = sync)); sync();
  if (cur) $('#cn-mode').value = cur.mode || 'auto';
  $('#cn-saved').onclick = (e) => {
    const u = e.target.closest('[data-use]'); const d = e.target.closest('[data-del]');
    if (u) { const s = S.saved[+u.dataset.use]; $('#cn-url').value = s.url; $('#cn-mode').value = s.mode || 'auto'; $('input[name=cn-kind][value=remote]').checked = true; sync(); setDirty(true); }
    if (d) { const i = +d.dataset.del; const s = S.saved[i]; const tok = savedTokens[s.url]; S.saved.splice(i, 1); delete savedTokens[s.url]; LS.set('tb.tokens', savedTokens); saveSettings(); $('#cn-saved').innerHTML = savedList();
      toast('Removed ' + s.url + '.', () => { S.saved.splice(Math.min(i, S.saved.length), 0, s); if (tok) { savedTokens[s.url] = tok; LS.set('tb.tokens', savedTokens); } saveSettings(); const el = $('#cn-saved'); if (el) el.innerHTML = savedList(); }); }
  };
}

/* ---------- about ---------- */
function openAbout() {
  openModal('About ToolBridge MCP', md([
    'ToolBridge is a **Model Context Protocol server** that connects an AI assistant to internal company tools, built with the official MCP TypeScript SDK (v2). This page runs the exact same server code in your browser.',
    '',
    '**What is real**',
    '- The MCP server, client, JSON-RPC traffic and protocol negotiation (2026-07-28 stateless, plus the 2025-era handshake for older clients).',
    '- Roles (viewer, agent, admin), dry-run writes, input validation, rate limits, the read-only SQL guard, redaction and the audit log.',
    '- Prompt-injection flagging: ticket IT-1007 and one wiki page contain planted instructions aimed at AI assistants.',
    '- Live AI mode calls your provider directly with function calling.',
    '',
    '**What is simulated**',
    '- All company data (Brightwave Labs, 24 people, tickets, metrics) is fictional and generated.',
    '- The demo planner is rule-based, not AI.',
    '- The Jira, ServiceNow, Slack and Postgres adapters in the repo are stubs that have **not** been tested against real systems.',
    '- OAuth 2.1 authorization is future work; the HTTP server uses bearer tokens.',
    '',
    'Your edits (tickets you create or change) and the audit log are kept in this browser only. Use **Reset demo data** on the Tools tab to start over.'
  ].join('\n')), { name: 'about', wide: true });
}

/* ---------- header wiring ---------- */
$('#btn-connect').onclick = openConnect;
$('#btn-settings').onclick = openSettings;
$('#btn-about').onclick = openAbout;
$('#btn-theme').onclick = () => { const d = document.documentElement.classList.toggle('dark'); try { localStorage.setItem('tb.theme', d ? 'dark' : 'light'); } catch (e) { /* ignore */ } };
$('#role').onchange = async (e) => {
  const prev = S.role; S.role = e.target.value; saveSettings();
  try { await doConnect({ kind: 'inpage' }); toast('Now acting as ' + S.role + '.'); } catch (err) { S.role = prev; saveSettings(); $('#role').value = prev; toast(err.message); }
};

/* ---------- start ---------- */
(async function start() {
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.get('role') && ['viewer', 'agent', 'admin'].includes(h.get('role'))) S.role = h.get('role');
  if (h.get('ask')) { app.draft = h.get('ask').slice(0, 2000); history.replaceState(null, '', location.pathname + location.search); }
  renderHeader(); renderPanel();
  const t = S.target && S.target.kind === 'remote' ? S.target : null;
  try {
    if (t) { try { await doConnect({ kind: 'remote', url: t.url, mode: t.mode, token: savedTokens[t.url] || '' }); return; } catch (e) { toast('Could not reconnect to ' + t.url + '; using the built-in server.'); } }
    await doConnect({ kind: 'inpage' });
  } catch (e) { app.error = e.message; renderHeader(); renderPanel(); }
})();
window.__tb = { app, S, isReadOnly };
