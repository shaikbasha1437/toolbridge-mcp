/* Read-only SQL guard for metrics_query. Layers: (1) this static check, (2) a separate in-memory database that
   holds only analytics tables, rebuilt from seed data, with PRAGMA query_only=ON, (3) a row cap. */
export const ALLOWED_TABLES = ['metrics_daily', 'deployments', 'incidents', 'tickets'];
const FORBIDDEN = ['insert', 'update', 'delete', 'drop', 'alter', 'create', 'replace', 'truncate', 'attach', 'detach', 'pragma', 'vacuum', 'reindex', 'analyze', 'grant', 'revoke', 'begin', 'commit', 'rollback', 'savepoint', 'release', 'recursive', 'into', 'copy', 'call', 'exec', 'execute', 'merge', 'upsert'];
const FORBIDDEN_FN = ['load_extension', 'readfile', 'writefile', 'edit', 'fts3_tokenizer', 'zeroblob', 'randomblob', 'sqlite_compileoption_get', 'sqlite_offset'];
/* Strip comments and string literals so keywords inside them don't count (and can't hide anything). */
export function stripSql(sql) {
  let out = ''; let i = 0; const s = String(sql);
  while (i < s.length) {
    const c = s[i]; const n = s[i + 1];
    if (c === '-' && n === '-') { while (i < s.length && s[i] !== '\n') i++; out += ' '; continue; }
    if (c === '/' && n === '*') { const j = s.indexOf('*/', i + 2); i = j < 0 ? s.length : j + 2; out += ' '; continue; }
    if (c === "'" ) { i++; while (i < s.length) { if (s[i] === "'" && s[i + 1] === "'") { i += 2; continue; } if (s[i] === "'") break; i++; } i++; out += "''"; continue; }
    if (c === '"' || c === '`' || c === '[') { const close = c === '[' ? ']' : c; const j = s.indexOf(close, i + 1); const ident = s.slice(i + 1, j < 0 ? s.length : j); out += ' ' + ident.replace(/\W/g, '_') + ' '; i = j < 0 ? s.length : j + 1; continue; }
    out += c; i++;
  }
  return out;
}
export function checkSql(sql, opts) {
  const o = Object.assign({ maxLength: 4000, maxTables: 4, allowed: ALLOWED_TABLES }, opts || {});
  const raw = String(sql || '').trim();
  if (!raw) return { ok: false, reason: 'The query is empty.' };
  if (raw.length > o.maxLength) return { ok: false, reason: 'The query is longer than ' + o.maxLength + ' characters.' };
  const s = stripSql(raw).replace(/;\s*$/, '');
  if (s.includes(';')) return { ok: false, reason: 'Only one statement is allowed (found a semicolon in the middle).' };
  const lower = s.toLowerCase();
  const first = (lower.match(/^\s*([a-z]+)/) || [])[1];
  if (first !== 'select' && first !== 'with') return { ok: false, reason: 'Only read-only SELECT queries are allowed (the query starts with "' + (first || '?').toUpperCase() + '").' };
  const words = new Set(lower.match(/[a-z_][a-z0-9_]*/g) || []);
  const bad = FORBIDDEN.filter((w) => words.has(w) && !(w === 'replace' && !/\breplace\b(?!\s*\()/.test(lower)));
  if (bad.length) return { ok: false, reason: 'Read-only guard: "' + bad[0].toUpperCase() + '" is not allowed in metrics queries.' };
  const fn = FORBIDDEN_FN.find((f) => new RegExp('\\b' + f + '\\s*\\(').test(lower));
  if (fn) return { ok: false, reason: 'Function ' + fn + '() is not allowed.' };
  if (/\bsqlite_\w+|\bpragma_\w+/.test(lower)) return { ok: false, reason: 'System tables (sqlite_*, pragma_*) are not available.' };
  const ctes = new Set(); const cteRe = /(?:\bwith\b|,)\s*([a-z_][a-z0-9_]*)\s*(?:\([^)]*\))?\s+as\s*\(/g; let m;
  while ((m = cteRe.exec(lower))) ctes.add(m[1]);
  const refs = []; const refRe = /\b(?:from|join)\s+([a-z_][a-z0-9_.]*)/g;
  while ((m = refRe.exec(lower))) refs.push(m[1]);
  for (const r of refs) {
    if (r.includes('.')) return { ok: false, reason: 'Schema-qualified names like "' + r + '" are not allowed.' };
    if (!o.allowed.includes(r) && !ctes.has(r)) return { ok: false, reason: 'Unknown table "' + r + '". Available tables: ' + o.allowed.join(', ') + '.' };
  }
  if (refs.filter((r) => !ctes.has(r)).length > o.maxTables) return { ok: false, reason: 'Too many table references (max ' + o.maxTables + ').' };
  return { ok: true, sql: raw.replace(/;\s*$/, '') };
}

/* Analytics database on sql.js. `SQL` is the initialised sql.js module (Node: require('sql.js'); browser: vendor build). */
export function createMetricsDb(SQL, data) {
  const db = new SQL.Database();
  const tables = { metrics_daily: data.metrics_daily, deployments: data.deployments, incidents: data.incidents };
  db.run('CREATE TABLE metrics_daily (date TEXT, service TEXT, requests INTEGER, errors INTEGER, p95_ms INTEGER, signups INTEGER, revenue_usd INTEGER)');
  db.run('CREATE TABLE deployments (id TEXT PRIMARY KEY, service TEXT, date TEXT, version TEXT, status TEXT, author_id TEXT)');
  db.run('CREATE TABLE incidents (id TEXT PRIMARY KEY, service TEXT, severity TEXT, started_at TEXT, resolved_at TEXT, summary TEXT)');
  db.run('CREATE TABLE tickets (id TEXT PRIMARY KEY, status TEXT, priority TEXT, category TEXT, requester_id TEXT, assignee_id TEXT, created_at TEXT, updated_at TEXT)');
  for (const [name, rows] of Object.entries(tables)) {
    if (!rows.length) continue; const cols = Object.keys(rows[0]);
    const st = db.prepare('INSERT INTO ' + name + ' (' + cols.join(',') + ') VALUES (' + cols.map(() => '?').join(',') + ')');
    rows.forEach((r) => st.run(cols.map((c) => r[c] ?? null))); st.free();
  }
  let ticketsVersion = -1;
  function syncTickets(tickets, version) {
    if (version === ticketsVersion) return;
    db.run('PRAGMA query_only = 0'); db.run('DELETE FROM tickets');
    const st = db.prepare('INSERT INTO tickets VALUES (?,?,?,?,?,?,?,?)');
    tickets.forEach((t) => st.run([t.id, t.status, t.priority, t.category, t.requester_id, t.assignee_id || null, t.created_at, t.updated_at])); st.free();
    db.run('PRAGMA query_only = 1'); ticketsVersion = version;
  }
  db.run('PRAGMA query_only = 1');
  return {
    syncTickets,
    query(sql, maxRows) {
      const g = checkSql(sql); if (!g.ok) { const e = new Error(g.reason); e.code = 'SQL_GUARD'; throw e; }
      const cap = Math.max(1, Math.min(500, maxRows || 100));
      const res = db.exec('SELECT * FROM (' + g.sql + ') LIMIT ' + (cap + 1));
      const r = res[0] || { columns: [], values: [] };
      const truncated = r.values.length > cap;
      return { columns: r.columns, rows: r.values.slice(0, cap).map((v) => Object.fromEntries(r.columns.map((c, i) => [c, v[i]]))), row_count: Math.min(cap, r.values.length), truncated };
    },
    close() { db.close(); }
  };
}
