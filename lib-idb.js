// Тонкая обёртка над IndexedDB: открыть базу и выполнить операцию, получив Promise.

function wrap(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// stores: { имя: { keyPath?, indexes?: { имя: keyPath } } }
export function openDb(name, version, stores) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, version);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const [storeName, def] of Object.entries(stores)) {
        let store;
        if (db.objectStoreNames.contains(storeName)) {
          store = req.transaction.objectStore(storeName);
        } else {
          store = db.createObjectStore(storeName, def.keyPath ? { keyPath: def.keyPath } : undefined);
        }
        for (const [indexName, keyPath] of Object.entries(def.indexes || {})) {
          if (!store.indexNames.contains(indexName)) store.createIndex(indexName, keyPath);
        }
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      resolve(new Db(db));
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('База данных занята другой вкладкой'));
  });
}

class Db {
  constructor(db) { this.db = db; }

  store(name, mode = 'readonly') {
    return this.db.transaction(name, mode).objectStore(name);
  }

  get(name, key) { return wrap(this.store(name).get(key)); }
  getAll(name) { return wrap(this.store(name).getAll()); }
  getAllByIndex(name, index, value) { return wrap(this.store(name).index(index).getAll(value)); }
  count(name) { return wrap(this.store(name).count()); }

  // Запись подтверждается только после завершения транзакции: данные уже на диске.
  write(names, fn) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(names, 'readwrite');
      let result;
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('Запись прервана'));
      try {
        result = fn(Array.isArray(names) ? names.map((n) => tx.objectStore(n)) : tx.objectStore(names));
      } catch (e) {
        tx.abort();
        reject(e);
      }
    });
  }

  put(name, value, key) { return this.write(name, (s) => { s.put(value, key); }); }
  putMany(name, values) { return this.write(name, (s) => { for (const v of values) s.put(v); }); }
  delete(name, key) { return this.write(name, (s) => { s.delete(key); }); }
  clear(name) { return this.write(name, (s) => { s.clear(); }); }
}
