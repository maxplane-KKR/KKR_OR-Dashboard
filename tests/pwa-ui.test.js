'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const adminFile = path.join(__dirname, '..', 'Admin.html');

class FakeElement {
  constructor(id = '') {
    this.id = id;
    this.children = [];
    this.dataset = {};
    this.attributes = new Map();
    this.value = '';
    this._textContent = '';
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.listeners = {};
    this.ownerDocument = null;
  }
  get textContent() {
    return this._textContent + this.children.map((child) => child.textContent || '').join('');
  }
  set textContent(value) {
    this._textContent = String(value == null ? '' : value);
    this.children = [];
  }
  appendChild(child) { this.children.push(child); return child; }
  append(...children) { children.forEach((child) => this.appendChild(child)); }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  addEventListener(name, handler) { this.listeners[name] = handler; }
  focus() { if (this.ownerDocument) this.ownerDocument.activeElement = this; }
}

class FakeDocument {
  constructor() {
    this.activeElement = null;
    this.elements = new Map();
    const ids = [
      'adminForm', 'cancelEditButton', 'submitButton', 'editingId', 'formTitle',
      'fieldDateTime', 'fieldHN', 'fieldAge', 'fieldGender', 'fieldWardOpd', 'fieldOrRoom',
      'fieldDiagnosis', 'fieldOperation', 'fieldSurgeon', 'fieldAnesthetist', 'fieldAnesthesia',
      'fieldRights', 'fieldComment', 'fieldSurgicalWound', 'fieldChecked', 'fieldNewSurgeryType',
      'listTableBody', 'mobileQueueList', 'listState', 'listStateTitle', 'listStateDetail',
      'listLoadingRing', 'queueContent', 'loadMoreButton', 'refreshAdminButton',
      'currentScopeLabel', 'rangeControls', 'scopeStartDate', 'scopeEndDate',
      'panelForm', 'panelList', 'panelFrequentWords', 'tabForm', 'tabList', 'tabFrequentWords',
      'frequentWordsForm', 'frequentWordsGroup', 'frequentWordsCurrentGroup', 'frequentWordsValue',
      'frequentWordsSubmitButton', 'frequentWordsCancelButton', 'frequentWordsTableBody',
      'frequentWordsCardList', 'frequentWordsListState', 'frequentWordsStateTitle',
      'frequentWordsStateDetail', 'frequentWordsLoadingRing', 'frequentWordsContent', 'toastRegion',
      'diagnosisOptions', 'operationOptions', 'surgeonOptions', 'anesthetistOptions',
      'rightsOptions', 'surgeryTypeOptions',
    ];
    ids.forEach((id) => {
      const element = new FakeElement(id);
      element.ownerDocument = this;
      this.elements.set(id, element);
    });
  }
  getElementById(id) { return this.elements.get(id) || null; }
  createElement(tagName) {
    const element = new FakeElement();
    element.tagName = String(tagName).toUpperCase();
    element.ownerDocument = this;
    return element;
  }
  createTextNode(value) {
    const element = new FakeElement();
    element.textContent = value;
    element.ownerDocument = this;
    return element;
  }
  querySelectorAll() { return []; }
}

function loadApi() {
  const html = fs.readFileSync(adminFile, 'utf8');
  const match = html.match(/<script[^>]+id=["']or-admin-core["'][^>]*>([\s\S]*?)<\/script>/);
  assert.ok(match, 'or-admin-core script is required');
  const exposed = {};
  vm.runInNewContext(match[1], {
    globalThis: exposed,
    console,
    Date,
    Intl,
    Map,
    Set,
    Promise,
    Object,
    Array,
    String,
    Number,
    Boolean,
    URL,
    Blob,
  }, { filename: 'Admin.html#or-admin-core' });
  return exposed.OR_ADMIN_TEST_API;
}

function success(data) { return { ok: true, data, error: null, meta: {} }; }

function frequentWord(value, normalizedKey = value.toLocaleLowerCase('th-TH')) {
  return { type: 'diagnosis', value, normalizedKey, createdAt: '2026-08-07T01:00:00.000Z' };
}

function queueItem(id = 'q1') {
  return {
    id, date: '2026-08-07', time: '08:00', hn: '1234', age: '', gender: '', wardOpd: '',
    orRoom: 'OR1', diagnosis: 'Diagnosis', operation: 'Operation', surgeon: 'Surgeon',
    anesthetist: 'Anesthetist', anesthesia: '', rights: '', comment: '', surgicalWound: '',
    surgeryTypes: [], checked: false, createdAt: '2026-08-07T01:00:00.000Z',
    updatedAt: '2026-08-07T01:00:00.000Z', deletedAt: '',
  };
}

function createHarness(initialFrequentWords = []) {
  const document = new FakeDocument();
  const syncCalls = [];
  const directCalls = [];
  const syncManager = {
    loadSnapshot: async (key, loader) => loader(),
    queueMutation: async (action, payload) => {
      syncCalls.push({ action, payload: { ...payload } });
      if (action === 'createQueue') {
        return { ok: true, data: { ...queueItem('op-client-1'), ...payload, id: 'op-client-1' }, error: null, meta: { pending: true, offline: true } };
      }
      if (action === 'createDatalistOption') {
        return { ok: true, data: { type: payload.type, value: payload.value, normalizedKey: 'appendectomy', createdAt: '2026-08-07T01:00:00.000Z' }, error: null, meta: { pending: true, offline: true } };
      }
      return { ok: true, data: { ...payload }, error: null, meta: { pending: true, offline: true } };
    },
  };
  const controller = loadApi().createAdminController({
    document,
    syncManager,
    isStaticPwa: true,
    listQueues: () => Promise.resolve(success({ items: [queueItem()], nextCursor: null })),
    getOptions: () => Promise.resolve(success({ diagnosis: [], operation: [], surgeon: [], anesthetist: [], rights: [], surgeryType: [] })),
    getFrequentWords: () => Promise.resolve(success({ items: initialFrequentWords })),
    createQueue: (payload) => (directCalls.push({ action: 'createQueue', payload }), Promise.resolve(success(queueItem('direct-q')))),
    updateQueue: (payload) => (directCalls.push({ action: 'updateQueue', payload }), Promise.resolve(success({ ...queueItem(payload.id), ...payload }))),
    deleteQueue: (payload) => (directCalls.push({ action: 'deleteQueue', payload }), Promise.resolve(success(payload))),
    setQueueStatus: (payload) => (directCalls.push({ action: 'setQueueStatus', payload }), Promise.resolve(success(payload))),
    createFrequentWord: (payload) => (directCalls.push({ action: 'createDatalistOption', payload }), Promise.resolve(success({ item: { type: payload.type, value: payload.value, normalizedKey: 'direct', createdAt: '2026-08-07T01:00:00.000Z' } }))),
    updateFrequentWord: (payload) => (directCalls.push({ action: 'updateDatalistOption', payload }), Promise.resolve(success({ item: payload }))),
    deleteFrequentWord: (payload) => (directCalls.push({ action: 'deleteDatalistOption', payload }), Promise.resolve(success(payload))),
    confirm: () => true,
    now: () => new Date('2026-08-07T08:00:00+07:00'),
    setInterval: () => 1,
    clearInterval() {},
    setTimeout: () => 1,
    clearTimeout() {},
    isNarrow: () => true,
  });
  return { controller, document, syncCalls, directCalls };
}

test('static Admin queues a new queue through sync and keeps the optimistic row', async () => {
  const harness = createHarness();
  harness.document.getElementById('fieldDateTime').value = '2026-08-07T08:00';
  harness.document.getElementById('fieldHN').value = '1234';
  harness.document.getElementById('fieldOperation').value = 'Operation';

  await harness.controller.handleFormSubmit({ preventDefault() {} });

  assert.equal(harness.directCalls.length, 0);
  assert.equal(harness.syncCalls[0].action, 'createQueue');
  assert.equal(harness.document.getElementById('listTableBody').children.length, 1);
  assert.match(harness.document.getElementById('toastRegion').textContent, /sync/);
  assert.equal(harness.document.getElementById('editingId').value, '');
});

test('static Admin saves a frequent word to sync and renders it immediately', async () => {
  const harness = createHarness();
  await harness.controller.loadFrequentWords();
  harness.document.getElementById('frequentWordsGroup').value = 'diagnosis';
  harness.document.getElementById('frequentWordsValue').value = 'Appendectomy';

  await harness.controller.handleFrequentWordsSubmit({ preventDefault() {} });

  assert.equal(harness.directCalls.length, 0);
  assert.equal(harness.syncCalls[0].action, 'createDatalistOption');
  assert.match(harness.document.getElementById('frequentWordsTableBody').textContent, /Appendectomy/);
  assert.match(harness.document.getElementById('toastRegion').textContent, /sync/);
  assert.equal(harness.document.getElementById('frequentWordsValue').value, '');
});

test('static Admin updates a frequent word locally while the whole row waits for sync', async () => {
  const original = frequentWord('Diagnosis old', 'diagnosis old');
  const harness = createHarness([original]);
  await harness.controller.loadFrequentWords();
  harness.controller.editFrequentWord(original);
  harness.document.getElementById('frequentWordsValue').value = 'Diagnosis new';

  await harness.controller.handleFrequentWordsSubmit({ preventDefault() {} });

  assert.equal(harness.directCalls.length, 0);
  assert.equal(harness.syncCalls[0].action, 'updateDatalistOption');
  assert.match(harness.document.getElementById('frequentWordsTableBody').textContent, /Diagnosis new/);
  assert.doesNotMatch(harness.document.getElementById('frequentWordsTableBody').textContent, /Diagnosis old/);
  assert.match(harness.document.getElementById('toastRegion').textContent, /sync/);
});

test('static Admin removes a frequent word locally while the whole row waits for sync', async () => {
  const original = frequentWord('Diagnosis old', 'diagnosis old');
  const harness = createHarness([original]);
  await harness.controller.loadFrequentWords();

  await harness.controller.removeFrequentWord(original);

  assert.equal(harness.directCalls.length, 0);
  assert.equal(harness.syncCalls[0].action, 'deleteDatalistOption');
  assert.doesNotMatch(harness.document.getElementById('frequentWordsTableBody').textContent, /Diagnosis old/);
  assert.match(harness.document.getElementById('toastRegion').textContent, /sync/);
});

test('static Admin routes queue status and delete mutations through sync', async () => {
  const harness = createHarness();
  await harness.controller.loadAdminPage({ scope: 'TODAY', cursor: null });
  await harness.controller.changeQueueStatus('q1', true, null);
  await harness.controller.removeQueue('q1');

  assert.deepEqual(harness.syncCalls.map((call) => call.action), ['setQueueStatus', 'deleteQueue']);
  assert.equal(harness.directCalls.length, 0);
  assert.equal(harness.document.getElementById('listTableBody').children.length, 0);
  assert.match(harness.document.getElementById('toastRegion').textContent, /sync/);
});
