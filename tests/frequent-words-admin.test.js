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
  }
  get textContent() { return this._textContent + this.children.map((child) => child.textContent).join(''); }
  set textContent(value) { this._textContent = String(value == null ? '' : value); this.children = []; }
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
    [
      'panelForm', 'panelList', 'panelFrequentWords', 'tabForm', 'tabList', 'tabFrequentWords',
      'frequentWordsForm', 'frequentWordsGroup', 'frequentWordsCurrentGroup', 'frequentWordsValue',
      'frequentWordsSubmitButton', 'frequentWordsCancelButton', 'frequentWordsTableBody',
      'frequentWordsCardList', 'frequentWordsListState', 'frequentWordsStateTitle',
      'frequentWordsStateDetail', 'frequentWordsLoadingRing', 'frequentWordsContent',
      'toastRegion',
      'diagnosisOptions', 'operationOptions', 'surgeonOptions', 'anesthetistOptions',
      'rightsOptions', 'surgeryTypeOptions',
    ].forEach((id) => {
      const element = new FakeElement(id);
      element.ownerDocument = this;
      this.elements.set(id, element);
    });
    this.elements.get('tabForm').dataset.adminTab = 'form';
    this.elements.get('tabList').dataset.adminTab = 'list';
    this.elements.get('tabFrequentWords').dataset.adminTab = 'frequentWords';
  }
  getElementById(id) { return this.elements.get(id) || null; }
  createElement(tagName) {
    const element = new FakeElement();
    element.tagName = String(tagName).toUpperCase();
    element.ownerDocument = this;
    return element;
  }
  querySelectorAll(selector) {
    if (selector === '[data-admin-tab]') {
      return ['tabForm', 'tabList', 'tabFrequentWords'].map((id) => this.elements.get(id));
    }
    return [];
  }
}

function loadApi() {
  const html = fs.readFileSync(adminFile, 'utf8');
  const match = html.match(/<script[^>]+id=["']or-admin-core["'][^>]*>([\s\S]*?)<\/script>/);
  assert.ok(match, 'ต้องมี script or-admin-core');
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
    setInterval: () => 1,
    clearInterval() {},
  }, { filename: 'Admin.html#or-admin-core' });
  return { api: exposed.OR_ADMIN_TEST_API, html };
}

function successful(data) {
  return { ok: true, data, error: null, meta: {} };
}

function entry(type, value, normalizedKey = value.toLocaleLowerCase('th-TH')) {
  return { type, value, normalizedKey, createdAt: '2026-08-07T01:00:00.000Z' };
}

function createHarness(overrides = {}) {
  const document = new FakeDocument();
  const calls = { frequentWords: [], create: [], update: [], remove: [], options: [] };
  const controller = loadApi().api.createAdminController({
    document,
    listQueues: () => Promise.resolve(successful({ items: [], nextCursor: null })),
    getOptions: (type) => (calls.options.push(type), Promise.resolve(successful({
      diagnosis: [], operation: [], surgeon: [], anesthetist: [], rights: [], surgeryType: [],
    }))),
    getFrequentWords: () => (calls.frequentWords.push({}), Promise.resolve(successful({ items: [] }))),
    createFrequentWord: (payload) => (calls.create.push({ ...payload }), Promise.resolve(successful({ item: entry(payload.type, payload.value) }))),
    updateFrequentWord: (payload) => (calls.update.push({ ...payload }), Promise.resolve(successful({ item: entry(payload.type, payload.value) }))),
    deleteFrequentWord: (payload) => (calls.remove.push({ ...payload }), Promise.resolve(successful({ item: entry(payload.type, 'deleted', payload.normalizedKey) }))),
    confirm: () => true,
    now: () => new Date('2026-08-07T08:00:00+07:00'),
    setInterval: () => 1,
    clearInterval() {},
    setTimeout: () => 1,
    clearTimeout() {},
    isNarrow: () => true,
    ...overrides,
  });
  return { controller, document, calls };
}

test('selecting a word group shows only terms from that group', async () => {
  const { html } = loadApi();
  assert.doesNotMatch(html, /id="frequentWordsFilter"/);
  const harness = createHarness({
    getFrequentWords: () => Promise.resolve(successful({
      items: [entry('diagnosis', 'Appendectomy', 'appendectomy'), entry('operation', 'Phaco', 'phaco')],
    })),
  });
  await harness.controller.loadFrequentWords();
  assert.match(harness.document.getElementById('frequentWordsTableBody').textContent, /Appendectomy/);
  assert.doesNotMatch(harness.document.getElementById('frequentWordsTableBody').textContent, /Phaco/);

  harness.controller.setFrequentWordsGroup('operation');
  assert.doesNotMatch(harness.document.getElementById('frequentWordsTableBody').textContent, /Appendectomy/);
  assert.match(harness.document.getElementById('frequentWordsTableBody').textContent, /Phaco/);
});

test('Admin มี panel และเมนูบาร์หน้าที่ 3 ชื่อ คำที่ใช้บ่อย พร้อม type ครบ 6 กลุ่ม', () => {
  const { html } = loadApi();

  assert.match(html, /id="panelFrequentWords"/);
  assert.match(html, /id="tabFrequentWords"[^>]+data-admin-tab="frequentWords"/);
  assert.match(html, /คำที่ใช้บ่อย/);
  ['diagnosis', 'operation', 'surgeon', 'anesthetist', 'rights', 'surgeryType']
    .forEach((type) => assert.match(html, new RegExp(type)));
});

test('โหลดคำที่ใช้บ่อยและสลับ mobile ไปหน้าที่ 3', async () => {
  const harness = createHarness({
    getFrequentWords: () => (harness.calls.frequentWords.push({}), Promise.resolve(successful({
      items: [entry('operation', 'Phaco + IOL', 'phaco + iol')],
    }))),
  });

  harness.controller.setFrequentWordsGroup('operation');
  await harness.controller.loadFrequentWords();
  assert.equal(harness.calls.frequentWords.length, 1);
  assert.match(harness.document.getElementById('frequentWordsTableBody').textContent, /Phaco \+ IOL/);

  harness.controller.switchAdminMobilePanel('frequentWords');
  assert.equal(harness.document.getElementById('panelFrequentWords').dataset.mobileActive, 'true');
  assert.equal(harness.document.getElementById('tabFrequentWords').getAttribute('aria-selected'), 'true');
});

test('เพิ่ม แก้ไข และลบคำส่ง payload row ที่ถูกต้องและโหลด datalist ใหม่', async () => {
  const harness = createHarness();
  await harness.controller.loadFrequentWords();

  harness.document.getElementById('frequentWordsGroup').value = 'operation';
  harness.document.getElementById('frequentWordsValue').value = 'Phaco + IOL';
  await harness.controller.handleFrequentWordsSubmit({ preventDefault() {} });
  assert.deepEqual(harness.calls.create, [{ type: 'operation', value: 'Phaco + IOL' }]);

  harness.controller.editFrequentWord(entry('operation', 'Phaco + IOL', 'phaco + iol'));
  harness.document.getElementById('frequentWordsValue').value = 'Phaco with IOL';
  await harness.controller.handleFrequentWordsSubmit({ preventDefault() {} });
  assert.deepEqual(harness.calls.update, [{ type: 'operation', normalizedKey: 'phaco + iol', value: 'Phaco with IOL' }]);

  await harness.controller.removeFrequentWord(entry('operation', 'Phaco with IOL', 'phaco with iol'));
  assert.deepEqual(harness.calls.remove, [{ type: 'operation', normalizedKey: 'phaco with iol' }]);
  assert.ok(harness.calls.options.length >= 3, 'หลัง mutation ต้องโหลด datalist ใหม่');
});

test('รายการคำใช้ text content สำหรับข้อความยาวหรือมี HTML-like text', async () => {
  const dangerous = '<img src=x onerror=alert(1)> คำที่ยาวสำหรับทดสอบการตัดบรรทัด';
  let harness;
  harness = createHarness({
    getFrequentWords: () => Promise.resolve(successful({ items: [entry('diagnosis', dangerous, 'dangerous')] })),
  });

  await harness.controller.loadFrequentWords();

  assert.match(harness.document.getElementById('frequentWordsTableBody').textContent, /<img src=x onerror=alert\(1\)>/);
  assert.equal(harness.document.getElementById('frequentWordsTableBody').children.length, 1);
});

test('server error คงข้อมูลและไม่แสดง success state', async () => {
  const harness = createHarness({
    createFrequentWord: () => Promise.resolve({ ok: false, data: null, error: { message: 'บันทึกไม่ได้' }, meta: {} }),
  });
  await harness.controller.loadFrequentWords();
  harness.document.getElementById('frequentWordsGroup').value = 'diagnosis';
  harness.document.getElementById('frequentWordsValue').value = 'คำที่บันทึกไม่ได้';
  await harness.controller.handleFrequentWordsSubmit({ preventDefault() {} });
  assert.equal(harness.document.getElementById('frequentWordsValue').value, 'คำที่บันทึกไม่ได้');
  assert.match(harness.document.getElementById('toastRegion')?.textContent || 'บันทึกไม่ได้', /บันทึกไม่ได้/);
});

test('success toast auto-dismisses and cancels the previous timer', async () => {
  const timers = [];
  const cleared = [];
  const harness = createHarness({
    setTimeout: (callback, delay) => {
      const timer = { id: timers.length + 1, callback, delay };
      timers.push(timer);
      return timer.id;
    },
    clearTimeout: (id) => cleared.push(id),
  });

  await harness.controller.loadFrequentWords();
  harness.document.getElementById('frequentWordsGroup').value = 'diagnosis';
  harness.document.getElementById('frequentWordsValue').value = 'คำแรก';
  await harness.controller.handleFrequentWordsSubmit({ preventDefault() {} });
  assert.equal(harness.document.getElementById('toastRegion').dataset.kind, 'success', harness.document.getElementById('toastRegion').textContent);
  assert.equal(timers[0].delay, 3500);
  assert.equal(harness.document.getElementById('toastRegion').hidden, false);

  harness.document.getElementById('frequentWordsValue').value = 'คำที่สอง';
  await harness.controller.handleFrequentWordsSubmit({ preventDefault() {} });
  assert.deepEqual(cleared, [1]);
  timers[1].callback();
  assert.equal(harness.document.getElementById('toastRegion').hidden, true);
});
