/* STUB, untested against a real database. metrics_query on Postgres via the optional `pg` package
   (npm i pg). Same static read-only guard, plus a READ ONLY transaction, statement_timeout and a role
   that should only have SELECT grants. */
import { checkSql } from '../../core/sqlguard.js';
import { ToolError } from '../../core/tools.js';
import { secretFrom } from './index.js';
export const postgresAdapter = {
  group: 'metrics', label: 'Postgres', status: 'stub-untested',
  async create(c, deps) {
    const tables = c.allowedTables || ['metrics_daily', 'deployments', 'incidents'];
    let pg; try { pg = deps.importer ? await deps.importer('pg') : await import('pg'); } catch (e) { throw new Error('The postgres adapter needs the "pg" package: npm install pg'); }
    const Pool = (pg.default || pg).Pool;
    const pool = new Pool({ connectionString: secretFrom(c, 'connectionString', deps.env), max: 3, statement_timeout: c.statementTimeoutMs || 5000 });
    return {
      overrides: {
        metrics_query: { async run(a) {
          const g = checkSql(a.sql, { allowed: tables }); if (!g.ok) throw new ToolError(g.reason, 'Write a single SELECT over: ' + tables.join(', ') + '.', 'SQL_GUARD');
          const cap = Math.min(500, a.max_rows || 100); const client = await pool.connect();
          try {
            await client.query('BEGIN TRANSACTION READ ONLY'); await client.query('SET LOCAL statement_timeout = ' + Number(c.statementTimeoutMs || 5000));
            const r = await client.query('SELECT * FROM (' + g.sql + ') AS q LIMIT ' + (cap + 1));
            await client.query('ROLLBACK');
            const rows = r.rows.slice(0, cap);
            return { structured: { columns: r.fields.map((f) => f.name), rows, row_count: rows.length, truncated: r.rows.length > cap }, summary: rows.length + ' row(s) from Postgres.' };
          } catch (e) { await client.query('ROLLBACK').catch(() => {}); if (e instanceof ToolError) throw e; throw new ToolError('Postgres error: ' + e.message, 'Check table and column names.', 'SQL_ERROR'); } finally { client.release(); }
        } }
      }
    };
  }
};
