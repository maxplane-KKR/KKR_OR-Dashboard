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

function createSheet(name, initialValues) {
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
    deleteRow(row) {
      values.splice(row - 1, 1);
    },
    values: () => values.map((row) => row.slice()),
  };
}

function createSpreadsheetDouble({ queues = [], datalist = [] } = {}) {
  const sheets = new Map([
    ['Queues', createSheet('Queues', [queueHeaders, ...queues])],
    ['DatalistOptions', createSheet('DatalistOptions', [datalistHeaders, ...datalist])],
  ]);
  return {
    getSheetByName: (name) => sheets.get(name) || null,
    insertSheet: (name) => {
      const sheet = createSheet(name, [[]]);
      sheets.set(name, sheet);
      return sheet;
    },
    sheet: (name) => sheets.get(name),
  };
}

function queueRow(overrides = {}) {
  const values = {
    id: '123e4567-e89b-42d3-a456-426614174000',
    createdAt: '2026-08-07T01:00:00.000Z',
    updatedAt: '2026-08-07T01:00:00.000Z',
    date: '2026-08-07',
    time: '08:00',
    hn: 'HN-001',
    age: 55,
    gender: 'หญิง',
    wardOpd: 'Ward 1',
    orRoom: 'OR 1',
    diagnosis: 'Cataract',
    operation: 'Phaco + IOL',
    surgeon: 'แพทย์ตัวอย่าง',
    anesthetist: 'วิสัญญีตัวอย่าง',
    anesthesia: 'LA',
    rights: 'ประกัน',
    comment: '',
    surgicalWound: 'No Wound',
    surgeryTypes: '["Type A","Type B"]',
    checked: false,
    deletedAt: '',
    ...overrides,
  };
  return queueHeaders.map((header) => values[header]);
}

function loadCurrentApp({ queues = [], datalist = [] } = {}) {
  const spreadsheet = createSpreadsheetDouble({ queues, datalist });
  const removedCacheKeys = [];
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
      getUuid: () => '123e4567-e89b-42d3-a456-426614174001',
      formatDate: () => '2026-08-07',
    },
    Session: { getScriptTimeZone: () => 'Asia/Bangkok' },
    CacheService: { getScriptCache: () => ({ remove: (key) => removedCacheKeys.push(key) }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'code.gs' });
  context.setupOrSpreadsheet();
  return { app: context, spreadsheet, removedCacheKeys };
}

test('createDatalistOption เพิ่ม row ใหม่และ getDatalistEntries คืนค่า normalized key', () => {
  const { app, spreadsheet } = loadCurrentApp();

  const created = app.createDatalistOption({ type: 'operation', value: '  Phaco   + IOL  ' });

  assert.equal(created.ok, true);
  assert.deepEqual(spreadsheet.sheet('DatalistOptions').values()[1].slice(0, 3), [
    'operation', 'Phaco + IOL', 'phaco + iol',
  ]);
  assert.deepEqual(app.getDatalistEntries().data.items[0].type, 'operation');
  assert.deepEqual(app.getDatalistEntries().data.items[0].value, 'Phaco + IOL');
});

test('createDatalistOption ปฏิเสธ type ที่ไม่รองรับ value ว่าง และ normalized key ซ้ำ', () => {
  const { app, spreadsheet } = loadCurrentApp({
    datalist: [['operation', 'Phaco + IOL', 'phaco + iol', '2026-08-07T01:00:00.000Z']],
  });

  assert.equal(app.createDatalistOption({ type: 'unknown', value: 'คำทดสอบ' }).ok, false);
  assert.equal(app.createDatalistOption({ type: '__proto__', value: 'คำทดสอบ' }).ok, false);
  assert.equal(app.createDatalistOption({ type: 'operation', value: '   ' }).ok, false);
  assert.equal(app.createDatalistOption({ type: 'operation', value: ' phaco + iol ' }).ok, false);
  assert.equal(spreadsheet.sheet('DatalistOptions').values().length, 2);
});

test('updateDatalistOption ปฏิเสธ normalized key ที่ชน row อื่นและไม่เปลี่ยนข้อมูลเดิม', () => {
  const { app, spreadsheet } = loadCurrentApp({
    datalist: [
      ['operation', 'Phaco + IOL', 'phaco + iol', '2026-08-01T01:00:00.000Z'],
      ['operation', 'Laparoscopy', 'laparoscopy', '2026-08-01T01:01:00.000Z'],
    ],
  });

  const result = app.updateDatalistOption({ type: 'operation', normalizedKey: 'phaco + iol', value: ' Laparoscopy ' });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'DUPLICATE_DATALIST_OPTION');
  assert.equal(spreadsheet.sheet('DatalistOptions').values()[1][1], 'Phaco + IOL');
});

test('updateDatalistOption แก้ทั้ง row และ sync ค่า scalar ใน Queues โดยไม่ลบ row คิว', () => {
  const { app, spreadsheet, removedCacheKeys } = loadCurrentApp({
    queues: [queueRow(), queueRow({ id: '123e4567-e89b-42d3-a456-426614174002', diagnosis: ' cataract ' })],
    datalist: [['diagnosis', 'Cataract', 'cataract', '2026-08-01T01:00:00.000Z']],
  });

  const updated = app.updateDatalistOption({
    type: 'diagnosis', normalizedKey: 'cataract', value: 'ต้อกระจก',
  });
  const datalistRow = spreadsheet.sheet('DatalistOptions').values()[1];
  const queueRows = spreadsheet.sheet('Queues').values();

  assert.equal(updated.ok, true);
  assert.deepEqual(datalistRow.slice(0, 4), [
    'diagnosis', 'ต้อกระจก', 'ต้อกระจก', '2026-08-01T01:00:00.000Z',
  ]);
  assert.equal(queueRows.length, 3);
  assert.equal(queueRows[1][10], 'ต้อกระจก');
  assert.equal(queueRows[2][10], 'ต้อกระจก');
  assert.equal(updated.data.affectedQueueRows, 2);
  assert.deepEqual(removedCacheKeys, ['or:v1:today:2026-08-07']);
  assert.deepEqual(JSON.parse(JSON.stringify(app.getDatalistOptions().data.diagnosis)), ['ต้อกระจก']);
});

test('deleteDatalistOption ลบทั้ง row และล้าง scalar ใน Queues โดยคง row คิวไว้', () => {
  const { app, spreadsheet } = loadCurrentApp({
    queues: [queueRow()],
    datalist: [['rights', 'ประกัน', 'ประกัน', '2026-08-01T01:00:00.000Z']],
  });

  const deleted = app.deleteDatalistOption({ type: 'rights', normalizedKey: 'ประกัน' });
  const queueRows = spreadsheet.sheet('Queues').values();

  assert.equal(deleted.ok, true);
  assert.equal(spreadsheet.sheet('DatalistOptions').values().length, 1);
  assert.equal(queueRows.length, 2);
  assert.equal(queueRows[1][15], '');
  assert.equal(deleted.data.affectedQueueRows, 1);
});

test('deleteDatalistOption กรองเฉพาะ surgeryType ที่ลบและเก็บสมาชิกอื่นไว้', () => {
  const { app, spreadsheet } = loadCurrentApp({
    queues: [queueRow()],
    datalist: [['surgeryType', 'Type A', 'type a', '2026-08-01T01:00:00.000Z']],
  });

  const deleted = app.deleteDatalistOption({ type: 'surgeryType', normalizedKey: 'type a' });
  const queueRowAfter = spreadsheet.sheet('Queues').values()[1];

  assert.equal(deleted.ok, true);
  assert.deepEqual(JSON.parse(queueRowAfter[18]), ['Type B']);
  assert.equal(deleted.data.affectedQueueRows, 1);
});
