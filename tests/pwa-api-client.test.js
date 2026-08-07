'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadClient() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'pwa', 'api-client.js'), 'utf8');
  const context = { console, Promise, JSON, String, Object, encodeURIComponent, URLSearchParams };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'pwa/api-client.js' });
  return context.createOrApiClient;
}

test('static client สร้าง GET action/payload ไปยัง same-origin API', async () => {
  const calls = [];
  const createOrApiClient = loadClient();
  const client = createOrApiClient({
    apiBase: '/api',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200, json: async () => ({ ok: true, data: { items: [] }, error: null, meta: {} }) };
    },
  });

  const result = await client.call('getQueues', { scope: 'TODAY' });

  assert.equal(result.ok, true);
  assert.match(calls[0].url, /^\/api\?api=1&action=getQueues&payload=/);
  assert.equal(calls[0].options, undefined);
  assert.match(decodeURIComponent(calls[0].url), /"scope":"TODAY"/);
});

test('static client สร้าง POST mutation พร้อม operationId และ baseUpdatedAt', async () => {
  const calls = [];
  const createOrApiClient = loadClient();
  const client = createOrApiClient({
    apiBase: '/api',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200, json: async () => ({ ok: true, data: { pending: false }, error: null, meta: {} }) };
    },
  });

  await client.call('updateQueue', { id: 'queue-1', hn: 'HN-001' }, {
    operationId: '123e4567-e89b-42d3-a456-426614174099',
    baseUpdatedAt: '2026-08-07T01:00:00.000Z',
  });

  assert.equal(calls[0].url, '/api');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    action: 'updateQueue',
    payload: { id: 'queue-1', hn: 'HN-001' },
    operationId: '123e4567-e89b-42d3-a456-426614174099',
    baseUpdatedAt: '2026-08-07T01:00:00.000Z',
  });
});

test('Google Apps Script mode ใช้ google.script.run แทน fetch', async () => {
  const calls = [];
  const createOrApiClient = loadClient();
  const google = { script: { run: {
    withSuccessHandler(handler) { this.success = handler; return this; },
    withFailureHandler(handler) { this.failure = handler; return this; },
    getDatalistEntries() { calls.push('getDatalistEntries'); this.success({ ok: true, data: { items: [] } }); },
  } } };
  const client = createOrApiClient({ google, fetchImpl: () => { throw new Error('ไม่ควรเรียก fetch'); } });

  const result = await client.call('getDatalistEntries');

  assert.equal(result.ok, true);
  assert.deepEqual(calls, ['getDatalistEntries']);
});

test('client คืน server error ได้ และแปลง network/HTTP error เป็น ApiError', async () => {
  const createOrApiClient = loadClient();
  const serverClient = createOrApiClient({
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({
      ok: false, data: null, error: { code: 'CONFLICT', message: 'ข้อมูลเปลี่ยนแล้ว' }, meta: {},
    }) }),
  });
  const serverError = await serverClient.call('updateQueue', { id: 'queue-1' }, {
    operationId: '123e4567-e89b-42d3-a456-426614174099',
  });
  assert.equal(serverError.ok, false);
  assert.equal(serverError.error.code, 'CONFLICT');

  const networkClient = createOrApiClient({ fetchImpl: async () => { throw new Error('offline'); } });
  await assert.rejects(
    networkClient.call('getQueues', {}),
    (error) => error.code === 'NETWORK_ERROR'
  );
});
