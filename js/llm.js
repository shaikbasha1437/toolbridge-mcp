/* Bring-your-own-key LLM client with tool (function) calling, called straight from the browser:
   OpenAI, Anthropic (with the anthropic-dangerous-direct-browser-access header), Google Gemini, or any
   OpenAI-compatible endpoint (OpenRouter, Ollama, LM Studio, vLLM). Derived from a shared helper
   provider module, extended with a provider-neutral tool-calling message format:
     { role:'user', content } | { role:'assistant', content, toolCalls:[{ id, name, args }] } | { role:'tool', toolCallId, name, content }
   The API key only ever goes into the request headers (or Gemini's x-goog-api-key header), never into prompts. */
export const PRICES = {
  'gpt-5-mini': { in: 0.25, out: 2.0 }, 'gpt-5-nano': { in: 0.05, out: 0.4 }, 'gpt-5': { in: 1.25, out: 10 }, 'gpt-5.4-mini': { in: 0.75, out: 4.5 }, 'gpt-4.1-mini': { in: 0.4, out: 1.6 }, 'gpt-4o-mini': { in: 0.15, out: 0.6 },
  'claude-haiku-4-5': { in: 1, out: 5 }, 'claude-haiku-5-5': { in: 0.1, out: 0.5 }, 'claude-sonnet-4-5': { in: 3, out: 15 }, 'claude-sonnet-5': { in: 2, out: 10 }, 'claude-sonnet-5-5': { in: 2, out: 10 },
  'gemini-2.5-flash': { in: 0.3, out: 2.5 }, 'gemini-2.5-flash-lite': { in: 0.1, out: 0.4 }, 'gemini-3.1-flash-lite': { in: 0.25, out: 1.5 }, 'gemini-2.5-pro': { in: 1.25, out: 10 }
};
export const PROVIDERS = {
  openai: { label: 'OpenAI', defaultModel: 'gpt-5-mini', models: ['gpt-5-mini', 'gpt-5-nano', 'gpt-5', 'gpt-5.4-mini', 'gpt-4.1-mini', 'gpt-4o-mini'], baseUrl: 'https://api.openai.com/v1', needsKey: true, keyHint: 'sk-...', keyUrl: 'https://platform.openai.com/api-keys' },
  anthropic: { label: 'Anthropic', defaultModel: 'claude-haiku-4-5', models: ['claude-haiku-4-5', 'claude-haiku-5-5', 'claude-sonnet-4-5', 'claude-sonnet-5', 'claude-sonnet-5-5'], baseUrl: 'https://api.anthropic.com/v1', needsKey: true, keyHint: 'sk-ant-...', keyUrl: 'https://console.anthropic.com/settings/keys' },
  gemini: { label: 'Google Gemini', defaultModel: 'gemini-2.5-flash', models: ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-2.5-pro'], baseUrl: 'https://generativelanguage.googleapis.com/v1beta', needsKey: true, keyHint: 'AIza...', keyUrl: 'https://aistudio.google.com/apikey' },
  compatible: { label: 'OpenAI-compatible', defaultModel: 'llama3.2', models: ['llama3.2', 'qwen2.5:7b', 'openai/gpt-5-mini', 'anthropic/claude-haiku-4.5'], baseUrl: 'http://localhost:11434/v1', needsKey: false, keyHint: 'optional', keyUrl: '' }
};
export const PRESETS = [
  { id: 'ollama', label: 'Ollama (local)', baseUrl: 'http://localhost:11434/v1', model: 'llama3.2' },
  { id: 'lmstudio', label: 'LM Studio (local)', baseUrl: 'http://localhost:1234/v1', model: 'local-model' },
  { id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-5-mini' }
];
const trimSlash = (u) => String(u || '').replace(/\/+$/, '');
/* Gemini's function declarations accept an OpenAPI-style subset of JSON Schema. */
export function geminiSchema(s) {
  if (!s || typeof s !== 'object') return s;
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (['additionalProperties', 'examples', 'default', '$schema', 'pattern', 'anyOf', 'oneOf', 'allOf', 'const'].includes(k)) continue;
    if (k === 'type') { const t = [].concat(v).filter((x) => x !== 'null'); out.type = t[0] || 'string'; if ([].concat(v).includes('null')) out.nullable = true; continue; }
    if (k === 'format' && !['date-time', 'enum'].includes(v)) continue;
    if (k === 'properties') { out.properties = Object.fromEntries(Object.entries(v).map(([n, p]) => [n, geminiSchema(p)])); continue; }
    if (k === 'items') { out.items = geminiSchema(v); continue; }
    out[k] = v;
  }
  return out;
}
export function toolName(n) { return String(n).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64); }
/* msg = { system, messages (neutral format), tools:[{ name, description, inputSchema }], maxTokens, temperature } */
export function buildRequest(cfg, msg) {
  const p = cfg.provider; const model = cfg.model || PROVIDERS[p].defaultModel; const key = cfg.key || '';
  const maxTokens = msg.maxTokens || 1200; const tools = msg.tools || [];
  if (p === 'anthropic') {
    const messages = [];
    for (const m of msg.messages) {
      if (m.role === 'tool') {
        const block = { type: 'tool_result', tool_use_id: m.toolCallId, content: m.content, is_error: !!m.isError };
        const last = messages[messages.length - 1];
        if (last && last.role === 'user' && Array.isArray(last.content) && last.content.every((b) => b.type === 'tool_result')) last.content.push(block); else messages.push({ role: 'user', content: [block] });
      } else if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length) {
        messages.push({ role: 'assistant', content: (m.content ? [{ type: 'text', text: m.content }] : []).concat(m.toolCalls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.args || {} }))) });
      } else messages.push({ role: m.role, content: m.content });
    }
    const body = { model, max_tokens: maxTokens, system: msg.system, messages };
    if (tools.length) body.tools = tools.map((t) => ({ name: toolName(t.name), description: t.description || '', input_schema: t.inputSchema || { type: 'object', properties: {} } }));
    if (msg.temperature != null) body.temperature = msg.temperature;
    return { url: trimSlash(cfg.baseUrl || PROVIDERS.anthropic.baseUrl) + '/messages', init: { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' }, body: JSON.stringify(body) } };
  }
  if (p === 'gemini') {
    const contents = [];
    for (const m of msg.messages) {
      if (m.role === 'tool') {
        const part = { functionResponse: { name: toolName(m.name), response: { content: m.content, is_error: !!m.isError } } };
        const last = contents[contents.length - 1];
        if (last && last.role === 'user' && last.parts.every((x) => x.functionResponse)) last.parts.push(part); else contents.push({ role: 'user', parts: [part] });
      } else if (m.role === 'assistant') contents.push({ role: 'model', parts: (m.content ? [{ text: m.content }] : []).concat((m.toolCalls || []).map((c) => Object.assign({ functionCall: { name: toolName(c.name), args: c.args || {} } }, c.thoughtSignature ? { thoughtSignature: c.thoughtSignature } : {}))) });
      else contents.push({ role: 'user', parts: [{ text: m.content }] });
    }
    const body = { systemInstruction: { parts: [{ text: msg.system }] }, contents, generationConfig: { maxOutputTokens: maxTokens } };
    if (tools.length) body.tools = [{ functionDeclarations: tools.map((t) => ({ name: toolName(t.name), description: t.description || '', parameters: geminiSchema(t.inputSchema || { type: 'object', properties: {} }) })) }];
    if (msg.temperature != null) body.generationConfig.temperature = msg.temperature;
    return { url: trimSlash(cfg.baseUrl || PROVIDERS.gemini.baseUrl) + '/models/' + encodeURIComponent(model) + ':generateContent', init: { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body) } };
  }
  const messages = [{ role: p === 'openai' ? 'developer' : 'system', content: msg.system }];
  for (const m of msg.messages) {
    if (m.role === 'tool') messages.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content });
    else if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length) messages.push({ role: 'assistant', content: m.content || null, tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: toolName(c.name), arguments: JSON.stringify(c.args || {}) } })) });
    else messages.push({ role: m.role, content: m.content });
  }
  const body = { model, messages };
  if (tools.length) { body.tools = tools.map((t) => ({ type: 'function', function: { name: toolName(t.name), description: t.description || '', parameters: t.inputSchema || { type: 'object', properties: {} } } })); body.tool_choice = 'auto'; }
  if (p === 'openai') { body.max_completion_tokens = /^(gpt-5|gpt-6|o\d)/.test(model) ? maxTokens + 1500 : maxTokens; if (/^gpt-5(-mini|-nano)?$/.test(model)) body.reasoning_effort = 'minimal'; else if (!/^(gpt-5|gpt-6|o\d)/.test(model) && msg.temperature != null) body.temperature = msg.temperature; } else { body.max_tokens = maxTokens; if (msg.temperature != null) body.temperature = msg.temperature; }
  const headers = { 'content-type': 'application/json' };
  if (key) headers.authorization = 'Bearer ' + key;
  if (p === 'compatible' && /openrouter\.ai/.test(cfg.baseUrl || '')) { headers['HTTP-Referer'] = 'https://shaikbasha1437.github.io/toolbridge-mcp/'; headers['X-Title'] = 'ToolBridge MCP playground'; }
  return { url: trimSlash(cfg.baseUrl || PROVIDERS[p].baseUrl) + '/chat/completions', init: { method: 'POST', headers, body: JSON.stringify(body) } };
}
let idSeq = 0; const newId = () => 'call_' + Date.now().toString(36) + (++idSeq);
/* Returns { text, toolCalls:[{ id, name, args }], usage, stop, model } */
export function parseResponse(provider, j, nameMap) {
  const back = (n) => (nameMap && nameMap[n]) || n;
  if (provider === 'anthropic') {
    const blocks = j.content || [];
    return { text: blocks.filter((c) => c.type === 'text').map((c) => c.text).join(''), toolCalls: blocks.filter((c) => c.type === 'tool_use').map((c) => ({ id: c.id, name: back(c.name), args: c.input || {} })), usage: { input: (j.usage && j.usage.input_tokens) || 0, output: (j.usage && j.usage.output_tokens) || 0 }, stop: j.stop_reason, model: j.model };
  }
  if (provider === 'gemini') {
    const c = (j.candidates || [])[0] || {}; const parts = (c.content && c.content.parts) || []; const u = j.usageMetadata || {};
    return { text: parts.filter((x) => x.text && !x.thought).map((x) => x.text).join(''), toolCalls: parts.filter((x) => x.functionCall).map((x) => ({ id: newId(), name: back(x.functionCall.name), args: x.functionCall.args || {}, thoughtSignature: x.thoughtSignature })), usage: { input: u.promptTokenCount || 0, output: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0) }, stop: c.finishReason, model: j.modelVersion };
  }
  const ch = (j.choices || [])[0] || {}; const m = ch.message || {}; const u = j.usage || {};
  const toolCalls = (m.tool_calls || []).map((c) => { let args = {}; try { args = JSON.parse((c.function && c.function.arguments) || '{}'); } catch (e) { args = { __unparsed: String(c.function && c.function.arguments) }; } return { id: c.id || newId(), name: back(c.function && c.function.name), args }; });
  return { text: m.content || '', toolCalls, usage: { input: u.prompt_tokens || 0, output: u.completion_tokens || 0 }, stop: ch.finish_reason, model: j.model };
}
export function priceFor(model) { if (PRICES[model]) return PRICES[model]; const k = Object.keys(PRICES).find((m) => String(model).endsWith('/' + m) || String(model).replace(/\./g, '-').endsWith(m)); return k ? PRICES[k] : null; }
export function cost(usage, model) { const p = priceFor(model); return p ? (usage.input * p.in + usage.output * p.out) / 1e6 : null; }
export function errorMessage(provider, status, j, text) {
  const raw = (j && ((j.error && (j.error.message || j.error.type)) || j.message)) || text || '';
  const badKey = status === 401 || status === 403 || (status === 400 && /api key|api_key/i.test(String(raw)));
  const hint = badKey ? 'The key was rejected. Check it and try again.' : status === 404 ? 'Model or endpoint not found. Check the model name and base URL.' : status === 429 ? 'Rate limit or quota reached on your account. Wait a moment or check billing.' : status >= 500 ? 'The provider had a server error. Try again.' : '';
  return (hint ? hint + ' ' : '') + '(' + (PROVIDERS[provider] ? PROVIDERS[provider].label : provider) + ' ' + status + (raw ? ': ' + String(raw).slice(0, 200) : '') + ')';
}
export async function call(cfg, msg, deps) {
  const d = deps || {};
  const f = d.fetch || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
  const now = d.now || (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  if (PROVIDERS[cfg.provider].needsKey && !cfg.key) throw new Error('Add your ' + PROVIDERS[cfg.provider].label + ' key in Settings first.');
  const req = buildRequest(cfg, msg);
  const nameMap = Object.fromEntries((msg.tools || []).map((t) => [toolName(t.name), t.name]));
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctl && setTimeout(() => ctl.abort(), d.timeoutMs || 90000);
  if (d.signal && ctl) d.signal.addEventListener('abort', () => ctl.abort(), { once: true });
  const t0 = now(); let res;
  try { res = await f(req.url, Object.assign({}, req.init, ctl ? { signal: ctl.signal } : {})); } catch (e) {
    if (timer) clearTimeout(timer);
    if (e && e.name === 'AbortError') throw new Error(d.signal && d.signal.aborted ? 'Stopped.' : 'The request timed out.');
    const local = /localhost|127\.0\.0\.1|\[::1\]/.test(req.url);
    throw new Error(local ? 'Could not reach ' + req.url + '. Is the server running, and does it allow this site (CORS)? For Ollama set OLLAMA_ORIGINS to include this site; in LM Studio turn on CORS. Your browser may also ask to allow local network access.' : 'Network error reaching ' + new URL(req.url).host + ' (offline, blocked, or CORS).' + (cfg.provider === 'openai' ? ' OpenAI has sometimes sent key errors without CORS headers, so a wrong or revoked key can also look like this. Check the key.' : ''));
  }
  if (timer) clearTimeout(timer);
  const txt = await res.text(); let j = null; try { j = JSON.parse(txt); } catch (e) { /* not JSON */ }
  if (!res.ok) throw Object.assign(new Error(errorMessage(cfg.provider, res.status, j, txt.slice(0, 200))), { status: res.status });
  if (!j) throw new Error('The provider sent a reply that was not JSON.');
  const out = parseResponse(cfg.provider, j, nameMap);
  out.latencyMs = Math.round(now() - t0); out.model = out.model || cfg.model || PROVIDERS[cfg.provider].defaultModel;
  out.cost = cost(out.usage, cfg.model || PROVIDERS[cfg.provider].defaultModel);
  return out;
}
