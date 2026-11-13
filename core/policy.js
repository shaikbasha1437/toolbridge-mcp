/* Roles, per-tool permissions and rate limits. Tokens map to principals in server config; the playground
   maps its role switcher to the same three roles. */
export const ROLES = ['viewer', 'agent', 'admin'];
export const ROLE_RANK = { viewer: 0, agent: 1, admin: 2 };
export const ROLE_INFO = {
  viewer: 'Read-only: directory, wiki, tickets, on-call, assets.',
  agent: 'Everything a viewer can do, plus expenses, metrics SQL, and creating or updating tickets (with confirmation).',
  admin: 'Everything, plus salary bands in profiles, closing other people’s tickets and reading the audit log.'
};
export function allowed(role, minRole) { return (ROLE_RANK[role] ?? -1) >= (ROLE_RANK[minRole] ?? 99); }

/* Token-bucket limiter: `perMinute` calls per principal, plus a stricter bucket for write tools. */
export function createRateLimiter(opts) {
  const o = Object.assign({ perMinute: 60, writesPerMinute: 10 }, opts || {});
  const buckets = new Map();
  function take(key, capacity, now) {
    let b = buckets.get(key);
    if (!b) { b = { tokens: capacity, at: now }; buckets.set(key, b); }
    b.tokens = Math.min(capacity, b.tokens + ((now - b.at) / 60000) * capacity); b.at = now;
    if (b.tokens >= 1) { b.tokens -= 1; return { ok: true }; }
    return { ok: false, retryAfterSec: Math.ceil(((1 - b.tokens) / capacity) * 60) };
  }
  return {
    options: o,
    check(principal, isWrite, now) {
      const t = now == null ? Date.now() : now;
      const a = take('all:' + principal, o.perMinute, t); if (!a.ok) return Object.assign(a, { limit: o.perMinute + ' calls per minute' });
      if (isWrite) { const w = take('write:' + principal, o.writesPerMinute, t); if (!w.ok) return Object.assign(w, { limit: o.writesPerMinute + ' write calls per minute' }); }
      return { ok: true };
    },
    reset() { buckets.clear(); }
  };
}
