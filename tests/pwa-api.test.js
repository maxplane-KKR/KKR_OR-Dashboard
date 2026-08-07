'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const queueHeaders = [
  'id', 'createdAt', 'updatedAt', 'date', 'time', 'hn', 'age', 'gender', 'wardOpd',
  'orRoom', 'diagnosis', 'operation', 'surgeon', 'anesthetist', 'anesthesia',
  'rights', 'comment', 'surgicalWound', 'surgeryTypes', 'checked', 'deletedAt',
];
const datalistHeaders = ['type', 'value', 'normalizedKey', 'createdAt'];
const archiveHeaders = ['archivedAt', 'sourceSheet', 'recordId', 'recordDate', 'archiveSheet'];
const syncHeaders = ['operationId', 'action', 'resultJson', 'createdAt'];

function createSheet(initialValues) {
  const values = initialValues.map((row) => row.slice());
  return {
    getLastRow: () => values.length,
    getLastColumn: () => Math.max(...values.map((row) => row.length), 0),
    getRange(row, column, rowCount, columnCount) {
      return {
        getValues: () => Array.from({ length: rowCount }, (_, rowOffset) =>
          Array.from({ length: columnCount }, (_, columnOffset) =>
            (values[row - 1 + rowOffset] || [])[column - 1 + columnOffset] ?? ''
          )
        ),
        setValues: (nextValues) => {
          nextValues.forEach((nextRow, rowOffset) => {
            const targetRow = row - 1 + rowOffset;
            values[targetRow] = values[targetRow] || [];
            nextRow.forEach((value, columnOffset) => {
              values[targetRow][column - 1 + columnOffset] = value;
            });
          });
        },
      };
    },
    deleteRow(row) { values.splice(row - 1, 1); },
    values: () => values.map((row) => row.slice()),
  };
}

function createSpreadsheet() {
  const sheets = new Map([
    ['Queues', createSheet([queueHeaders])],
    ['DatalistOptions', createSheet([datalistHeaders])],
    ['ArchiveLog', createSheet([archiveHeaders])],
    ['SyncOperations', createSheet([syncHeaders])],
  ]);
  return {
    getSheetByName: (name) => sheets.get(name) || null,
    insertSheet: (name) => {
      const sheet = createSheet([[]]);
      sheets.set(name, sheet);
      return sheet;
    },
    sheet: (name) => sheets.get(name),
  };
}

function createContentService() {
  return {
    MimeType: { JSON: 'application/json' },
    createTextOutput(content) {
      return {
        content: String(content),
        mimeType: 'text/plain',
        setMimeType(mimeType) {
          this.mimeType = mimeType;
          return this;
        },
      };
    },
  };
}

function loadApp() {
  const spreadsheet = createSpreadsheet();
  let uuidCounter = 0;
  const htmlOutputs = [];
  const contentService = createContentService();
  const source = fs.readFileSync(path.join(__dirname, '..', 'code.gs'), 'utf8');
  const context = {
    console,
    JSON,
    Date,
    Math,
    String,
    Number,
    Boolean,
    Array,
    Object,
    SpreadsheetApp: { getActiveSpreadsheet: () => spreadsheet },
    Utilities: {
      getUuid: () => `123e4567-e89b-42d3-a456-42661417400${++uuidCounter}`,
      formatDate: () => '2026-08-07',
    },
    Session: { getScriptTimeZone: () => 'Asia/Bangkok' },
    CacheService: { getScriptCache: () => ({ remove() {}, get() { return null; }, put() {} }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    ContentService: contentService,
    HtmlService: {
      createTemplateFromFile(page) {
        const output = {
          page,
          title: '',
          meta: [],
          evaluate() { return this; },
          setTitle(value) { this.title = value; return this; },
          addMetaTag(name, content) { this.meta.push({ name, content }); return this; },
        };
        htmlOutputs.push(output);
        return output;
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'code.gs' });
  context.setupOrSpreadsheet();
  return { app: context, spreadsheet, htmlOutputs };
}

function apiEvent({ method = 'GET', action, payload = {}, operationId = '' } = {}) {
  return {
    parameter: { api: '1', action, payload: JSON.stringify(payload) },
    postData: method === 'POST'
      ? { contents: JSON.stringify({ action, payload, operationId }) }
      : undefined,
  };
}

function readOutput(output) {
  assert.equal(output.mimeType, 'application/json');
  return JSON.parse(output.content);
}

function queuePayload() {
  return {
    date: '2026-08-07', time: '08:00', hn: 'HN-001', age: 40, gender: 'หญิง',
    wardOpd: 'Ward 1', orRoom: 'OR 1', diagnosis: 'Cataract', operation: 'Phaco',
    surgeon: 'แพทย์', anesthetist: 'วิสัญญี', anesthesia: 'LA', rights: 'ประกัน',
    comment: '', surgicalWound: 'No Wound', surgeryTypes: [], checked: false,
  };
}

test('doGet API mode คืน JSON envelope และ dispatch getDatalistEntries', () => {
  const { app } = loadApp();
  const response = readOutput(app.doGet(apiEvent({ action: 'getDatalistEntries' })));

  assert.equal(response.ok, true);
  assert.deepEqual(response.data, { items: [] });
  assert.equal(response.error, null);
  assert.match(response.requestId, /^[0-9a-f-]{36}$/i);
  assert.match(response.serverTime, /^\d{4}-\d{2}-\d{2}T/);
});

test('doPost dispatch mutation และ operation เดิมคืนผลเดิมโดยไม่เขียนซ้ำ', () => {
  const { app, spreadsheet } = loadApp();
  const operationId = '123e4567-e89b-42d3-a456-426614174099';
  const event = apiEvent({
    method: 'POST',
    action: 'createDatalistOption',
    payload: { type: 'operation', value: 'Phaco' },
    operationId,
  });

  const first = readOutput(app.doPost(event));
  const second = readOutput(app.doPost(event));

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.deepEqual(second.data, first.data);
  assert.equal(spreadsheet.sheet('DatalistOptions').values().length, 2);
  assert.equal(spreadsheet.sheet('SyncOperations').values().length, 2);
});

test('createQueue accepts a client-generated UUID for offline replay', () => {
  const { app, spreadsheet } = loadApp();
  const clientId = '11111111-1111-4111-8111-111111111111';
  const response = readOutput(app.doPost(apiEvent({
    method: 'POST',
    action: 'createQueue',
    payload: { ...queuePayload(), id: clientId },
    operationId: '22222222-2222-4222-8222-222222222222',
  })));

  assert.equal(response.ok, true);
  assert.equal(response.data.id, clientId);
  assert.equal(spreadsheet.sheet('Queues').values()[1][0], clientId);
});

test('API ปฏิเสธ action ที่ไม่อยู่ใน allowlist และ payload JSON ที่เสีย', () => {
  const { app } = loadApp();
  const forbidden = readOutput(app.doGet(apiEvent({ action: 'eval' })));
  const invalid = readOutput(app.doGet({ parameter: { api: '1', action: 'getQueues', payload: '{' } }));

  assert.equal(forbidden.ok, false);
  assert.equal(forbidden.error.code, 'API_ACTION_NOT_ALLOWED');
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, 'API_REQUEST_INVALID');
});

test('doGet HTML mode คงการส่งหน้า Admin เดิม', () => {
  const { app, htmlOutputs } = loadApp();
  const output = app.doGet({ parameter: { page: 'admin' } });

  assert.equal(output.page, 'Admin');
  assert.equal(output.title, 'OR Admin');
  assert.equal(htmlOutputs.length > 0, true);
});

test('deleteQueue เก็บ row ไว้และไม่คืนใน getQueues หลัง soft delete', () => {
  const { app, spreadsheet } = loadApp();
  const created = app.createQueue(queuePayload());
  const id = created.data.id;
  const deleted = app.deleteQueue({ id });

  assert.equal(deleted.ok, true);
  assert.equal(spreadsheet.sheet('Queues').values().length, 2);
  assert.ok(spreadsheet.sheet('Queues').values()[1][20]);
  assert.equal(app.getQueues({ scope: 'ALL' }).data.items.length, 0);
});
