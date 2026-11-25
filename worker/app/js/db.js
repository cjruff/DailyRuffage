// Local storage: IndexedDB holds the full cookbook so search is instant and works offline.
// Code: © Corey J Ruff

const DB_NAME = 'daily-ruffage';
const DB_VERSION = 1;
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('recipes')) db.createObjectStore('recipes', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      if (!db.objectStoreNames.contains('images')) db.createObjectStore('images');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function tx(store, mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    Promise.resolve(fn(s)).then(v => { out = v; });
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

const reqP = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export const db = {
  all: () => tx('recipes', 'readonly', s => reqP(s.getAll())),
  get: id => tx('recipes', 'readonly', s => reqP(s.get(id))),
  put: r => tx('recipes', 'readwrite', s => { s.put(r); }),
  putMany: rs => tx('recipes', 'readwrite', s => { rs.forEach(r => s.put(r)); }),
  clear: () => tx('recipes', 'readwrite', s => { s.clear(); }),
  getMeta: k => tx('meta', 'readonly', s => reqP(s.get(k))),
  setMeta: (k, v) => tx('meta', 'readwrite', s => { s.put(v, k); }),
  getImage: k => tx('images', 'readonly', s => reqP(s.get(k))),
  putImage: (k, blob) => tx('images', 'readwrite', s => { s.put(blob, k); }),
};

export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16);
  });
}

export function blankRecipe() {
  const now = new Date().toISOString();
  return {
    id: uuid(), title: '', description: '', servings: '', prepTime: '', cookTime: '',
    ingredients: [], steps: [], notes: '', tags: [], favorite: false, rating: 0,
    source: '', sourceUrl: '', origin: '', images: [], addedBy: '', needsReview: false,
    createdAt: now, updatedAt: now, deleted: false,
  };
}
