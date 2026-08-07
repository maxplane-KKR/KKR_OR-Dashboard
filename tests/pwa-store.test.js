'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

class FakeRequest {
  constructor(work) {
    this.onsuccess = null;
    this.onerror = null;
    setImmediate(() => {
      try {
        this.result = work();
        if (this.onsuccess) this.onsuccess({ target: this });
      } catch (error) {
        this.error = error;
        if (this.onerror) this.onerror({ target: this });
      }
    });
  }
}

function createFakeIndexedDB() {
  const databases = new Map();

  function open(name) {
    const request = { onsuccess: null, onerror: null, onupgradeneeded: null, result: null, error: null };
    setImmediate(() => {
      try {
        let database = databases.get(name);
        const firstOpen = !database;
        if (!database) {
          database = { stores: new Map() };
          databases.set(name, database);
        }
        const db = {
          objectStoreNames: { contains: (storeName) => database.stores.has(storeName) },
          createObjectStore(storeName, options) {
            database.stores.set(storeName, { keyPath: options.keyPath, values: new Map() });
            return database.stores.get(storeName);
          },
          transaction(storeNames) {
            return {
              objectStore(storeName) {
                const store = database.stores.get(storeName);
                return {
                  get: (key) => new FakeRequest(() => store.values.get(key)),
                  getAll: () => new FakeRequest(() => Array.from(store.values.values()).map((value) => ({ ...value }))),
                  put: (value) => new FakeRequest(() => { store.values.set(value[store.keyPath], { ...value }); return value; }),
                  delete: (key) => new FakeRequest(() => { store.values.delete(key); return undefined; }),
                };
              },
            };
          },
        };
        request.result = db;
        if (firstOpen && request.onupgradeneeded) request.onupgradeneeded({ target: request });
        if (request.onsuccess) request.onsuccess({ target: request });
      } catch (error) {
        request.error = error;
        if (request.onerror) request.onerror({ target: request });
      }
    });
    return request;
  }

  return { open };
}

function loadStore(indexedDB) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'pwa', 'store.js'), 'utf8');
  const context = { console, Promise, Object, Array, String, Date, setImmediate, indexedDB };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'pwa/store.js' });
  return context.createOrStore;
}

test('store บันทึกและอ่าน snapshot ได้โดยไม่ต้องมี account', async () => {
  const createOrStore = loadStore(createFakeIndexedDB());
  const store = createOrStore({ now: () => '2026-08-07T01:00:00.000Z' });

  await store.putSnapshot('dashboard:today', { items: [{ id: 'q1' }] });
  const snapshot = await store.getSnapshot('dashboard:today');

  assert.deepEqual(snapshot, {
    key: 'dashboard:today',
    value: { items: [{ id: 'q1' }] },
    savedAt: '2026-08-07T01:00:00.000Z',
  });
});

test('outbox เรียงตาม createdAt, กัน operation ซ้ำ และแก้ retry ได้', async () => {
  const createOrStore = loadStore(createFakeIndexedDB());
  const store = createOrStore({ now: () => '2026-08-07T01:00:00.000Z' });
  const first = { operationId: 'op-1', action: 'createQueue', payload: { id: 'q1' }, createdAt: '2026-08-07T01:00:01.000Z' };
  const second = { operationId: 'op-2', action: 'deleteQueue', payload: { id: 'q2' }, createdAt: '2026-08-07T01:00:02.000Z' };

  const savedFirst = await store.enqueueMutation(first);
  const duplicate = await store.enqueueMutation({ ...first, payload: { id: 'different' } });
  await store.enqueueMutation(second);
  await store.updateMutation('op-1', { attempts: 2, status: 'retry', lastError: 'offline' });

  assert.deepEqual(JSON.parse(JSON.stringify(savedFirst)), JSON.parse(JSON.stringify(duplicate)));
  assert.deepEqual((await store.listPendingMutations()).map((item) => item.operationId), ['op-1', 'op-2']);
  assert.equal((await store.listPendingMutations())[0].attempts, 2);
  await store.removeMutation('op-1');
  assert.deepEqual((await store.listPendingMutations()).map((item) => item.operationId), ['op-2']);
});

test('store คืน STORAGE_UNAVAILABLE เมื่อไม่มี IndexedDB', async () => {
  const createOrStore = loadStore(null);
  const store = createOrStore({ indexedDB: null });

  await assert.rejects(store.getSnapshot('dashboard:today'), (error) => error.code === 'STORAGE_UNAVAILABLE');
});
