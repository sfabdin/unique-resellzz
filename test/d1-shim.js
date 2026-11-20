// A stand-in for Cloudflare D1 built on Node's own SQLite, so the tests can run
// the Worker in plain Node. It mirrors the parts of D1's API the shop uses:
// prepare().bind().first()/all()/run(), and batch() as one transaction.

import { DatabaseSync } from 'node:sqlite';

const READS = /^\s*(SELECT|WITH|PRAGMA)\b|\bRETURNING\b/i;

class Statement {
  constructor(d1, sql, args = []) {
    this.d1 = d1;
    this.sql = sql;
    this.args = args;
  }

  bind(...args) {
    return new Statement(this.d1, this.sql, args.map((a) => {
      if (a === undefined) throw new TypeError('D1_TYPE_ERROR: Type \'undefined\' not supported');
      if (a instanceof ArrayBuffer) return new Uint8Array(a);
      if (typeof a === 'boolean') return a ? 1 : 0;
      return a;
    }));
  }

  exec() {
    this.d1.queries += 1;
    const st = this.d1.sqlite.prepare(this.sql);
    if (READS.test(this.sql)) {
      const results = st.all(...this.args).map((r) => {
        const o = { ...r };
        for (const k of Object.keys(o)) if (o[k] instanceof Uint8Array) o[k] = o[k].buffer.slice(o[k].byteOffset, o[k].byteOffset + o[k].byteLength);
        return o;
      });
      return { success: true, results, meta: { changes: 0, last_row_id: 0 } };
    }
    const r = st.run(...this.args);
    return { success: true, results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }

  async first(col) {
    const row = this.exec().results[0] ?? null;
    return col && row ? row[col] : row;
  }

  async all() { return this.exec(); }
  async run() { return this.exec(); }
}

export class D1Shim {
  constructor() {
    this.sqlite = new DatabaseSync(':memory:');
    this.queries = 0;
  }

  prepare(sql) { return new Statement(this, sql); }

  async batch(statements) {
    this.sqlite.exec('BEGIN');
    try {
      const out = statements.map((s) => s.exec());
      this.sqlite.exec('COMMIT');
      return out;
    } catch (err) {
      this.sqlite.exec('ROLLBACK');
      throw err;
    }
  }
}
