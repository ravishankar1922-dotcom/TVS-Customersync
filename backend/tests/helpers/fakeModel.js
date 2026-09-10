/**
 * A minimal, generic in-memory stand-in for a Mongoose Model.
 *
 * WHY THIS EXISTS: this sandbox's outbound network is allowlisted to the
 * package registries only (npm/pypi/crates/etc.) — `fastdl.mongodb.org`,
 * the host mongodb-memory-server needs to download a real `mongod` binary,
 * is not reachable (confirmed via the agent-proxy's own connect-rejected
 * log: "gateway answered 403 to CONNECT" for fastdl.mongodb.org:443), and
 * no real MongoDB is installed or installable via apt on this box either.
 * A real MongoDB integration test run was therefore not possible here.
 *
 * This fake reproduces the small slice of the Mongoose Model/Query API the
 * BalanceSync routes actually use (see the grep audit in the QA report),
 * backed by a plain in-memory array, so the REAL route handlers, REAL
 * middleware, and REAL business-logic modules run unmodified against it —
 * only the persistence layer is faked. It is intentionally NOT a claim of
 * full MongoDB-semantics fidelity: it does not enforce unique indexes,
 * does not replicate Mongo's document-level write locking, and its
 * findOneAndUpdate is atomic only in the trivial sense that Node is
 * single-threaded and no `await` is awaited mid-mutation here — so it CAN
 * mask certain multi-operation race conditions a real MongoDB deployment
 * (or mongodb-memory-server) would surface. Tests that specifically target
 * the race-condition fix note this caveat explicitly.
 */
const { EventEmitter } = require('events');

function matches(doc, filter = {}) {
  return Object.entries(filter).every(([key, cond]) => {
    if (key === '$or') return cond.some(sub => matches(doc, sub));
    const val = doc[key];
    if (cond && typeof cond === 'object' && !Array.isArray(cond) && !(cond instanceof Date)) {
      return Object.entries(cond).every(([op, opVal]) => {
        switch (op) {
          case '$in': return opVal.includes(val);
          case '$nin': return !opVal.includes(val);
          case '$ne': return val !== opVal;
          case '$gt': return val > opVal;
          case '$gte': return val >= opVal;
          case '$lt': return val < opVal;
          case '$lte': return val <= opVal;
          case '$exists': return opVal ? val !== undefined : val === undefined;
          case '$regex': return new RegExp(opVal, cond.$options || '').test(val ?? '');
          default: return true;
        }
      });
    }
    return val === cond;
  });
}

function clone(o) { return o === undefined ? o : JSON.parse(JSON.stringify(o)); }

// A fake, but ObjectId-*shaped* (24 lowercase hex chars) id, so code that
// does `new mongoose.Types.ObjectId(someId)` or just string-compares ids
// (as every route in this codebase does) behaves the same as it would
// against a real Mongo ObjectId's string form.
function fakeObjectId() {
  const hex = '0123456789abcdef';
  let s = '';
  for (let i = 0; i < 24; i++) s += hex[Math.floor(Math.random() * 16)];
  return s;
}

function applyUpdate(doc, update) {
  const set = update.$set || (!update.$push && !update.$set ? update : {});
  const plainSet = { ...set };
  Object.keys(update).forEach(k => { if (!k.startsWith('$')) plainSet[k] = update[k]; });
  Object.assign(doc, clone(plainSet));
  if (update.$push) {
    Object.entries(update.$push).forEach(([field, val]) => {
      if (!Array.isArray(doc[field])) doc[field] = [];
      doc[field].push(clone(val));
    });
  }
  if (update.$unset) Object.keys(update.$unset).forEach(k => { delete doc[k]; });
  return doc;
}

function withDocMethods(model, doc) {
  if (doc == null) return doc;
  Object.defineProperty(doc, 'save', { value: async function () { model._upsertByRef(doc); return doc; }, enumerable: false, configurable: true });
  Object.defineProperty(doc, 'toObject', { value: function () { return clone(doc); }, enumerable: false, configurable: true });
  return doc;
}

class FakeQuery {
  constructor(model, method, filter, opts = {}) {
    this.model = model; this.method = method; this.filter = filter; this.opts = opts;
    this._lean = false; this._sort = null;
  }
  lean() { this._lean = true; return this; }
  sort(spec) { this._sort = spec; return this; }
  limit(n) { this._limit = n; return this; }
  select() { return this; } // no-op, fields not restricted in the fake
  distinct(field) {
    const rows = this.model.data.filter(d => matches(d, this.filter));
    return Promise.resolve([...new Set(rows.map(r => r[field]))]);
  }
  _materialize() {
    let rows = this.model.data.filter(d => matches(d, this.filter));
    if (this._sort) {
      const [[field, dir]] = Object.entries(this._sort);
      rows = [...rows].sort((a, b) => (a[field] > b[field] ? 1 : a[field] < b[field] ? -1 : 0) * (dir === -1 || dir === 'desc' ? -1 : 1));
    }
    if (this._limit) rows = rows.slice(0, this._limit);
    return rows;
  }
  then(resolve, reject) {
    try {
      if (this.method === 'find') {
        const rows = this._materialize().map(clone);
        resolve(this._lean ? rows : rows.map(r => withDocMethods(this.model, r)));
      } else if (this.method === 'findOne') {
        const row = this._materialize()[0];
        resolve(row ? (this._lean ? clone(row) : withDocMethods(this.model, clone(row))) : null);
      }
    } catch (e) { reject(e); }
  }
  catch(reject) { return this.then(undefined, reject); }
}

class FakeModel extends EventEmitter {
  constructor(name) { super(); this.modelName = name; this.data = []; }
  reset() { this.data = []; }
  _upsertByRef(doc) {
    const idx = this.data.findIndex(d => d._fakeId === doc._fakeId);
    if (idx >= 0) this.data[idx] = clone(doc); else { doc._fakeId = doc._fakeId || Math.random().toString(36).slice(2); this.data.push(clone(doc)); }
  }
  find(filter = {}) { return new FakeQuery(this, 'find', filter); }
  findOne(filter = {}) { return new FakeQuery(this, 'findOne', filter); }
  // Real Mongoose's findById(id) is sugar for findOne({_id: id}); string ids
  // (as every route here passes, e.g. from req.params) compare fine against
  // our string-form fake ids.
  findById(id) { return new FakeQuery(this, 'findOne', { _id: (id && id.toString) ? id.toString() : id }); }
  async create(input) {
    const arr = Array.isArray(input) ? input : [input];
    const created = arr.map(o => { const d = { _id: fakeObjectId(), _fakeId: Math.random().toString(36).slice(2), createdAt: new Date(), updatedAt: new Date(), ...clone(o) }; this.data.push(d); return withDocMethods(this, clone(d)); });
    return Array.isArray(input) ? created : created[0];
  }
  async findOneAndUpdate(filter, update, opts = {}) {
    let row = this.data.find(d => matches(d, filter));
    if (!row) {
      if (!opts.upsert) return null;
      row = { _id: fakeObjectId(), _fakeId: Math.random().toString(36).slice(2), createdAt: new Date(), ...Object.fromEntries(Object.entries(filter).filter(([, v]) => typeof v !== 'object')) };
      this.data.push(row);
    }
    applyUpdate(row, update);
    row.updatedAt = new Date();
    return withDocMethods(this, clone(row));
  }
  async updateOne(filter, update) {
    const row = this.data.find(d => matches(d, filter));
    if (!row) return { matchedCount: 0, modifiedCount: 0, n: 0, nModified: 0 };
    applyUpdate(row, update);
    return { matchedCount: 1, modifiedCount: 1, n: 1, nModified: 1 };
  }
  async updateMany(filter, update) {
    const rows = this.data.filter(d => matches(d, filter));
    rows.forEach(r => applyUpdate(r, update));
    return { matchedCount: rows.length, modifiedCount: rows.length, n: rows.length, nModified: rows.length };
  }
  async deleteOne(filter) {
    const idx = this.data.findIndex(d => matches(d, filter));
    if (idx >= 0) this.data.splice(idx, 1);
    return { deletedCount: idx >= 0 ? 1 : 0 };
  }
  async exists(filter) {
    const row = this.data.find(d => matches(d, filter));
    return row ? { _id: row._fakeId } : null;
  }
}

module.exports = { FakeModel, matches, clone };
