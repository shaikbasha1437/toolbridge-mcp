/* Small UI toolkit shared by the playground: escaping, a tiny markdown renderer, toasts with undo, modals that
   close via X, Cancel, Esc, backdrop click and browser Back (with a discard prompt for unsaved edits), downloads,
   and a JSON-Schema-driven form. */
export const $ = (s, r) => (r || document).querySelector(s);
export const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
export const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function md(text) {
  const lines = String(text || '').split('\n'); const out = []; let list = false; let tbl = null;
  const inline = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  const flush = () => { if (list) { out.push('</ul>'); list = false; } if (tbl) { out.push('<table><thead><tr>' + tbl[0].map((c) => '<th>' + inline(c) + '</th>').join('') + '</tr></thead><tbody>' + tbl.slice(1).map((r) => '<tr>' + r.map((c) => '<td>' + inline(c) + '</td>').join('') + '</tr>').join('') + '</tbody></table>'); tbl = null; } };
  for (const l of lines) {
    if (/^\s*\|.*\|\s*$/.test(l)) { if (/^\s*\|[\s:|-]+\|\s*$/.test(l)) continue; if (list) { out.push('</ul>'); list = false; } (tbl = tbl || []).push(l.trim().slice(1, -1).split('|').map((c) => c.trim())); continue; }
    if (/^\s*[-*] /.test(l)) { if (tbl) flush(); if (!list) { out.push('<ul>'); list = true; } out.push('<li>' + inline(l.replace(/^\s*[-*] /, '')) + '</li>'); continue; }
    flush(); out.push(l.trim() ? '<div>' + inline(l) + '</div>' : '<div style="height:6px"></div>');
  }
  flush(); return out.join('');
}
let toastTimer = null;
export function toast(msg, undo) {
  const t = $('#toast');
  t.innerHTML = '<span>' + esc(msg) + '</span>' + (undo ? '<button type="button" id="toast-undo">Undo</button>' : '') + '<button type="button" id="toast-x" aria-label="Dismiss">×</button>';
  t.classList.add('show');
  if (undo) $('#toast-undo').onclick = () => { t.classList.remove('show'); undo(); };
  $('#toast-x').onclick = () => t.classList.remove('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), undo ? 9000 : 4000);
}
let modal = null; let lastFocus = null;
export function modalOpen() { return !!modal; }
export function modalName() { return modal ? modal.name : ''; }
export function openModal(title, html, o) {
  const op = o || {};
  if (modal) removeModal('replaced'); else lastFocus = document.activeElement;
  history.pushState({ tbModal: true }, '');
  $('#modal-host').innerHTML = '<div class="backdrop"><section class="modal ' + (op.wide ? 'wide' : '') + '" role="dialog" aria-modal="true" aria-labelledby="modal-title" data-name="' + esc(op.name || '') + '"><div class="modal-header"><h2 id="modal-title">' + esc(title) + '</h2><button type="button" data-close="x" aria-label="Close">×</button></div><div class="modal-body">' + html + '</div><div class="modal-footer">' + (op.extraFooter || '') + '<button type="button" data-close="cancel">' + esc(op.cancelLabel || (op.save ? 'Cancel' : 'Close')) + '</button>' + (op.save ? '<button type="button" id="modal-save" class="primary">' + esc(op.saveLabel || 'Save') + '</button>' : '') + '</div></section></div>';
  modal = { dirty: false, watch: !!op.dirty, onClose: op.onClose || null, name: op.name || '' };
  document.body.style.overflow = 'hidden';
  $('.backdrop').addEventListener('mousedown', (e) => { if (e.target.classList.contains('backdrop')) closeModal(); });
  $$('[data-close]').forEach((b) => (b.onclick = () => closeModal()));
  $('.modal-body').addEventListener('input', () => { if (modal && modal.watch) modal.dirty = true; });
  $('.modal-body').addEventListener('change', () => { if (modal && modal.watch) modal.dirty = true; });
  if (op.save) $('#modal-save').onclick = () => op.save();
  if (op.onmount) op.onmount();
  setTimeout(() => { if (!modal) return; const first = $('.modal-body input:not([type=checkbox]):not([type=radio]):not([type=hidden]):not([readonly]),.modal-body textarea,.modal-body select'); const el = op.focusFirst && first ? first : $('.modal [data-close=x]'); if (el) el.focus(); }, 0);
}
export function setDirty(v) { if (modal) modal.dirty = v; }
function removeModal(reason) { const m = modal; modal = null; $('#modal-host').innerHTML = ''; document.body.style.overflow = ''; if (reason !== 'replaced' && lastFocus && lastFocus.focus && document.contains(lastFocus)) lastFocus.focus({ preventScroll: true }); if (m && m.onClose) m.onClose(reason || 'cancel'); }
export function closeModal(force, reason) {
  if (!modal || modal.closing) return;
  if (!force && modal.dirty && !confirm('Discard unsaved changes?')) return;
  modal.dirty = false; modal.closing = true; modal.reason = reason; const m = modal;
  history.back(); setTimeout(() => { if (modal === m) removeModal(m.reason); }, 800);
}
addEventListener('popstate', () => { if (!modal) return; if (!modal.closing && modal.dirty && !confirm('Discard unsaved changes?')) { history.pushState({ tbModal: true }, ''); return; } removeModal(modal.reason); });
addEventListener('keydown', (e) => {
  if (!modal) return;
  if (e.key === 'Escape') { e.preventDefault(); closeModal(); return; }
  if (e.key === 'Tab') { const els = $$('.modal button,.modal input,.modal select,.modal textarea,.modal a[href],.modal summary').filter((x) => !x.disabled && x.offsetParent !== null); if (!els.length) return; const first = els[0]; const last = els[els.length - 1]; if (e.shiftKey && document.activeElement === first) { last.focus(); e.preventDefault(); } else if (!e.shiftKey && document.activeElement === last) { first.focus(); e.preventDefault(); } }
});
export function download(name, data, type) { const blob = new Blob([data], { type: type || 'text/plain' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500); }

/* JSON Schema -> form fields (flat object schemas, which is what MCP tools and prompt args use). */
export function schemaForm(schema, prefix, values) {
  const props = (schema && schema.properties) || {}; const req = new Set((schema && schema.required) || []); const v = values || {};
  if (!Object.keys(props).length) return '<p class="muted small">This takes no arguments.</p>';
  return Object.entries(props).map(([k, p]) => {
    const id = prefix + '-' + k; const label = '<label for="' + id + '">' + esc(k) + (req.has(k) ? ' <span class="req" title="required">*</span>' : '') + '</label>';
    const help = p.description || p.examples ? '<div class="help">' + esc(p.description || '') + (p.examples ? ' e.g. ' + esc(p.examples[0]) : '') + (p.default !== undefined ? ' (default ' + esc(JSON.stringify(p.default)) + ')' : '') + '</div>' : '';
    const t = [].concat(p.type || 'string')[0]; const cur = v[k];
    let input;
    if (p.enum) input = '<select id="' + id + '" data-key="' + esc(k) + '" data-type="' + t + '"><option value="">' + (req.has(k) ? 'Choose…' : '(not set)') + '</option>' + p.enum.map((x) => '<option' + (cur === x ? ' selected' : '') + '>' + esc(x) + '</option>').join('') + '</select>';
    else if (t === 'boolean') return '<div class="field"><label class="chk"><input type="checkbox" id="' + id + '" data-key="' + esc(k) + '" data-type="boolean"' + (cur ? ' checked' : '') + '> <span><b>' + esc(k) + '</b><br><span class="muted small">' + esc(p.description || '') + '</span></span></label></div>';
    else if (t === 'integer' || t === 'number') input = '<input type="number" id="' + id + '" data-key="' + esc(k) + '" data-type="' + t + '"' + (p.minimum != null ? ' min="' + p.minimum + '"' : '') + (p.maximum != null ? ' max="' + p.maximum + '"' : '') + (t === 'integer' ? ' step="1"' : ' step="any"') + ' value="' + esc(cur ?? '') + '">';
    else if (t === 'array') input = '<input id="' + id + '" data-key="' + esc(k) + '" data-type="array" placeholder="comma-separated" value="' + esc(Array.isArray(cur) ? cur.join(', ') : '') + '">';
    else if (t === 'object') input = '<textarea id="' + id + '" data-key="' + esc(k) + '" data-type="object" rows="3" placeholder="{ }">' + esc(cur ? JSON.stringify(cur) : '') + '</textarea>';
    else if ((p.maxLength || 0) > 300 || /description|sql|comment|body/.test(k)) input = '<textarea id="' + id + '" data-key="' + esc(k) + '" data-type="string" rows="' + (k === 'sql' ? 5 : 3) + '"' + (k === 'sql' ? ' spellcheck="false" class="mono"' : '') + '>' + esc(cur ?? '') + '</textarea>';
    else input = '<input id="' + id + '" data-key="' + esc(k) + '" data-type="string" value="' + esc(cur ?? '') + '"' + (p.pattern ? ' pattern="' + esc(p.pattern) + '"' : '') + ' autocomplete="off">';
    return '<div class="field">' + label + input + help + '</div>';
  }).join('');
}
export function readForm(root, schema) {
  const out = {}; const errors = []; const req = new Set((schema && schema.required) || []);
  $$('[data-key]', root).forEach((el) => {
    const k = el.dataset.key; const t = el.dataset.type;
    if (t === 'boolean') { if (el.checked) out[k] = true; return; }
    const raw = el.value.trim(); if (raw === '') { if (req.has(k)) errors.push(k + ' is required'); return; }
    if (t === 'integer' || t === 'number') { const n = Number(raw); if (Number.isNaN(n)) errors.push(k + ' must be a number'); else out[k] = n; }
    else if (t === 'array') out[k] = raw.split(',').map((x) => x.trim()).filter(Boolean);
    else if (t === 'object') { try { out[k] = JSON.parse(raw); } catch (e) { errors.push(k + ' must be JSON'); } }
    else out[k] = raw;
  });
  return { values: out, errors };
}
