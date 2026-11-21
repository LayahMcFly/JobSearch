/* A stand-in for Cloudflare D1 built on Node's real SQLite (node:sqlite). The SQL the Worker runs is executed by a real
   SQL engine, but this is NOT D1: it cannot show D1's real latency, consistency across regions, limits or billing.
   It can inject the error messages D1 documents for exhausted free-tier limits. */
const { DatabaseSync } = require('node:sqlite');
const WRITE_LIMIT = "D1_ERROR: Your account has exceeded D1's free tier daily row write limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue.";
const READ_LIMIT = "D1_ERROR: Your account has exceeded D1's free tier daily row read limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue.";
function makeD1() {
  const db = new DatabaseSync(':memory:');
  const st = { queries: 0, failWrites: null, failReads: null, failAll: null };
  const isWrite = s => /^\s*(insert|update|delete|create|drop|alter)/i.test(s);
  const guard = sql => { st.queries++; if (st.failAll) throw new Error(st.failAll); if (isWrite(sql) && st.failWrites) throw new Error(st.failWrites); if (!isWrite(sql) && st.failReads) throw new Error(st.failReads); };
  class Stmt {
    constructor(sql, params) { this.sql = sql; this.params = params || []; }
    bind(...p) { return new Stmt(this.sql, p); }
    async first() { guard(this.sql); const r = db.prepare(this.sql).get(...this.params); return r ? Object.assign({}, r) : null; }
    async all() { guard(this.sql); return { results: db.prepare(this.sql).all(...this.params).map(r => Object.assign({}, r)), meta: {} }; }
    async run() { guard(this.sql); const r = db.prepare(this.sql).run(...this.params); return { success: true, results: [], meta: { changes: Number(r.changes) } }; }
  }
  return {
    prepare: sql => new Stmt(sql),
    async batch(stmts) { db.exec('BEGIN'); try { const out = []; for (const s of stmts) out.push(await s.run()); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; } },
    _raw: db, _st: st, WRITE_LIMIT, READ_LIMIT
  };
}
module.exports = { makeD1, WRITE_LIMIT, READ_LIMIT };
