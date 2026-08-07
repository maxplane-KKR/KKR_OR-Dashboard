'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadSync(overrides = {}) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'pwa', 'sync.js'), 'utf8');
  const context = { console, Promise, Object, Array, String, Date, Math, Error, setTimeout, clearTimeout, ...overrides };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'pwa/sync.js' });
  return context.createOrSyncManager;
}

function createStore(initial = {}) {
  const snapshots = new Map(Object.entries(initial.snapshots || {}));
  const outbox = new Map();
  return {
    snapshots,
    outbox,
    async getSnapshot(key) { return snapshots.get(key) || undefined; },
    async putSnapshot(key, value) {
      const record = { key, value, savedAt: '2026-08-07T01:00:00.000Z' };
      snapshots.set(key, record);
      return record;
    },
    async enqueueMutation(item) {
      const existing = outbox.get(item.operationId);
      if (existing) return existing;
      outbox.set(item.operationId, { ...item });
      return outbox.get(item.operationId);
    },
    async listPendingMutations() {
      return [...outbox.values()]
        .filter((item) => item.status !== 'conflict' && item.status !== 'done')
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    },
    async updateMutation(id, patch) {
      const updated = { ...outbox.get(id), ...patch };
      outbox.set(id, updated);
      return updated;
    },
    async removeMutation(id) { outbox.delete(id); },
  };
}

test('offline read คืน snapshot ล่าสุด และไม่มี snapshot คืน OFFLINE_NO_SNAPSHOT', async () => {
  const createOrSyncManager = loadSync();
  const store = createStore({ snapshots: {
    'dashboard:today': { key: 'dashboard:today', value: { items: [{ id: 'q1' }] }, savedAt: '2026-08-07T00:00:00.000Z' },
  } });
  const manager = createOrSyncManager({ store, online: () => false, now: () => '2026-08-07T01:00:00.000Z' });

  const cached = await manager.loadSnapshot('dashboard:today', async () => ({ ok: true, data: { items: [] } }));
  assert.deepEqual(cached.data, { items: [{ id: 'q1' }] });
  assert.equal(cached.meta.cached, true);
  await assert.rejects(manager.loadSnapshot('admin:frequentWords', async () => ({ ok: true, data: {} })), (error) => error.code === 'OFFLINE_NO_SNAPSHOT');
});

test('offline mutation ลง outbox และยังไม่เรียก API', async () => {
  const createOrSyncManager = loadSync();
  const store = createStore();
  let apiCalls = 0;
  const manager = createOrSyncManager({
    store,
    online: () => false,
    now: () => '2026-08-07T01:00:00.000Z',
    operationIdFactory: () => 'op-1',
    apiClient: { call: async () => { apiCalls += 1; return { ok: true, data: {} }; } },
  });

  const result = await manager.queueMutation('createQueue', { id: 'q1' }, '2026-08-07T00:00:00.000Z');

  assert.equal(result.ok, true);
  assert.equal(result.meta.pending, true);
  assert.equal(result.meta.offline, true);
  assert.equal(apiCalls, 0);
  assert.equal(store.outbox.size, 1);
  assert.equal(manager.getStatus(), 'offline');
});

test('flush ส่งตามลำดับ, ลบ success, เก็บ retry และหยุด conflict', async () => {
  const createOrSyncManager = loadSync();
  const store = createStore();
  store.outbox.set('op-1', { operationId: 'op-1', action: 'createQueue', payload: { id: 'q1' }, createdAt: '2026-08-07T01:00:01.000Z', attempts: 0, status: 'pending' });
  store.outbox.set('op-2', { operationId: 'op-2', action: 'updateQueue', payload: { id: 'q2' }, createdAt: '2026-08-07T01:00:02.000Z', attempts: 0, status: 'pending' });
  store.outbox.set('op-3', { operationId: 'op-3', action: 'deleteQueue', payload: { id: 'q3' }, createdAt: '2026-08-07T01:00:03.000Z', attempts: 0, status: 'pending' });
  const calls = [];
  const manager = createOrSyncManager({
    store,
    online: () => true,
    now: () => '2026-08-07T01:00:10.000Z',
    apiClient: { call: async (action, payload, options) => {
      calls.push({ action, payload, options });
      if (action === 'updateQueue') throw Object.assign(new Error('offline'), { name: 'ApiError', code: 'NETWORK_ERROR' });
      if (action === 'deleteQueue') return { ok: false, data: null, error: { code: 'CONFLICT', message: 'ข้อมูลเปลี่ยนแล้ว' }, meta: {} };
      return { ok: true, data: { id: 'q1' }, error: null, meta: {} };
    } },
  });

  await manager.flush();

  assert.deepEqual(calls.map((call) => call.action), ['createQueue', 'updateQueue', 'deleteQueue']);
  assert.equal(store.outbox.has('op-1'), false);
  assert.equal(store.outbox.get('op-2').status, 'retry');
  assert.equal(store.outbox.get('op-2').attempts, 1);
  assert.equal(store.outbox.get('op-3').status, 'conflict');
  assert.equal(manager.getStatus(), 'conflict');
});

test('offline createQueue creates a client id and returns the optimistic queue item', async () => {
  const createOrSyncManager = loadSync();
  const store = createStore();
  const manager = createOrSyncManager({
    store,
    online: () => false,
    now: () => '2026-08-07T01:00:00.000Z',
    operationIdFactory: () => 'op-client-1',
    clientIdFactory: () => 'op-client-1',
    apiClient: { call: async () => ({ ok: true, data: {} }) },
  });

  const result = await manager.queueMutation('createQueue', { hn: '1234' }, '');

  assert.equal(result.data.id, 'op-client-1');
  assert.equal(result.data.createdAt, '2026-08-07T01:00:00.000Z');
  assert.equal(store.outbox.get('op-client-1').payload.id, 'op-client-1');
});

test('online event flushes the outbox after an offline mutation', async () => {
  let online = false;
  const events = {};
  const createOrSyncManager = loadSync({
    addEventListener: (name, handler) => { events[name] = handler; },
  });
  const store = createStore();
  let apiCalls = 0;
  const manager = createOrSyncManager({
    store,
    online: () => online,
    operationIdFactory: () => 'op-event',
    apiClient: { call: async () => { apiCalls += 1; return { ok: true, data: { id: 'q1' } }; } },
  });

  await manager.queueMutation('updateQueue', { id: 'q1' }, '');
  online = true;
  await events.online();

  assert.equal(apiCalls, 1);
  assert.equal(manager.getStatus(), 'online');
  assert.equal(store.outbox.size, 0);
});

test('conflict response is returned to the caller and remains marked for review', async () => {
  const createOrSyncManager = loadSync();
  const store = createStore();
  const manager = createOrSyncManager({
    store,
    online: () => true,
    operationIdFactory: () => 'op-conflict',
    apiClient: { call: async () => ({
      ok: false,
      data: null,
      error: { code: 'CONFLICT', message: 'ข้อมูลเปลี่ยนแล้ว' },
      meta: {},
    }) },
  });

  const result = await manager.queueMutation('updateQueue', { id: 'q1' }, '');

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'CONFLICT');
  assert.equal(store.outbox.get('op-conflict').status, 'conflict');
  assert.equal(manager.getStatus(), 'conflict');
});
