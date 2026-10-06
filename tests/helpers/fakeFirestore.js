/**
 * Minimal in-memory Firestore for tests: doc get/set(merge = deep map merge)/
 * update/delete, collection doc()/where(==, <=)/limit/get, transactions and
 * FieldValue sentinels used by the code under test.
 */
const isPlainObject = (v) => v && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v) && !v.__fv;

function deepMerge(base, patch) {
  const out = { ...(base || {}) };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : resolve(v, out[k]);
  }
  return out;
}

function resolve(v, current) {
  if (v && v.__fv === 'increment') return (typeof current === 'number' ? current : 0) + v.n;
  if (v && v.__fv === 'ts') return new Date();
  if (isPlainObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolve(x)]));
  return v;
}

function createFakeFirestore() {
  const store = new Map();
  let autoId = 0;

  const docRef = (path) => ({
    path,
    id: path.split('/').pop(),
    collection: (c) => collectionRef(`${path}/${c}`),
    get: async () => snapshot(path),
    set: async (data, opts) => {
      store.set(path, opts && opts.merge ? deepMerge(store.get(path), data) : resolve(data));
    },
    update: async (data) => {
      if (!store.has(path)) throw new Error(`no document ${path}`);
      store.set(path, deepMerge(store.get(path), data));
    },
    delete: async () => { store.delete(path); },
  });

  const snapshot = (path) => ({
    exists: store.has(path),
    id: path.split('/').pop(),
    ref: docRef(path),
    data: () => store.get(path),
  });

  const query = (path, filters, max) => ({
    where: (field, op, value) => query(path, [...filters, { field, op, value }], max),
    limit: (n) => query(path, filters, n),
    orderBy: () => query(path, filters, max),
    get: async () => {
      const depth = path.split('/').length + 1;
      let docs = [...store.keys()]
        .filter((k) => k.startsWith(path + '/') && k.split('/').length === depth)
        .map(snapshot)
        .filter((s) => filters.every(({ field, op, value }) => {
          const v = s.data()[field];
          const num = (x) => (x instanceof Date ? x.getTime() : x);
          if (op === '==') return v === value;
          if (op === '<=') return v != null && num(v) <= num(value);
          throw new Error(`fake firestore: op ${op} not supported`);
        }));
      if (max) docs = docs.slice(0, max);
      return { docs, empty: docs.length === 0, size: docs.length };
    },
  });

  const collectionRef = (path) => ({
    ...query(path, [], null),
    doc: (id) => docRef(`${path}/${id || `auto${++autoId}`}`),
  });

  const db = {
    collection: collectionRef,
    runTransaction: async (fn) => fn({
      get: (ref) => ref.get(),
      set: (ref, data, opts) => { ref.set(data, opts); },
      update: (ref, data) => { ref.update(data); },
      delete: (ref) => { ref.delete(); },
    }),
    batch: () => {
      const ops = [];
      return {
        update: (ref, data) => ops.push(() => ref.update(data)),
        set: (ref, data, opts) => ops.push(() => ref.set(data, opts)),
        commit: async () => { for (const op of ops) await op(); },
      };
    },
  };

  const FieldValue = {
    increment: (n) => ({ __fv: 'increment', n }),
    serverTimestamp: () => ({ __fv: 'ts' }),
  };

  return { db, store, FieldValue };
}

module.exports = { createFakeFirestore };
