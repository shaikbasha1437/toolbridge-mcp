/* Audit log: every tool call, resource read and prompt fetch becomes one redacted JSON line.
   Keeps a ring buffer in memory; `sink` receives each line (Node appends to a JSONL file). */
import { redact } from './redact.js';
let seq = 0;
export function createAudit(opts) {
  const o = Object.assign({ max: 1000, sink: null, now: () => Date.now() }, opts || {});
  let entries = [];
  const listeners = new Set();
  return {
    record(e) {
      const entry = Object.assign({ ts: new Date(o.now()).toISOString(), id: 'a' + (++seq).toString(36) + Math.floor(Math.random() * 1e6).toString(36) }, e, { args: e.args === undefined ? undefined : redact(e.args), detail: e.detail === undefined ? undefined : redact(e.detail) });
      Object.keys(entry).forEach((k) => entry[k] === undefined && delete entry[k]);
      entries.push(entry); if (entries.length > o.max) entries = entries.slice(-o.max);
      if (o.sink) { try { o.sink(JSON.stringify(entry)); } catch (err) { /* never let logging break a call */ } }
      listeners.forEach((fn) => fn(entry));
      return entry;
    },
    list(q) {
      const f = q || {}; let out = entries.slice().reverse();
      if (f.outcome) out = out.filter((x) => x.outcome === f.outcome);
      if (f.principal) out = out.filter((x) => x.principal === f.principal);
      return out.slice(0, f.limit || 50);
    },
    all() { return entries.slice(); },
    load(list) { entries = (list || []).slice(-o.max); },
    clear() { const old = entries; entries = []; return old; },
    toJsonl() { return entries.map((x) => JSON.stringify(x)).join('\n') + (entries.length ? '\n' : ''); },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
  };
}
