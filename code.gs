var DASHBOARD_PAGE_NAME = 'Index';
var ADMIN_PAGE_NAME = 'Admin';
var QUEUE_SHEET_NAME = 'Queues';
var DATALIST_SHEET_NAME = 'DatalistOptions';
var ARCHIVE_LOG_SHEET_NAME = 'ArchiveLog';
var SYNC_SHEET_NAME = 'SyncOperations';
var CACHE_PREFIX = 'or:v1:';
var ACTIVE_RETENTION_DAYS = 90;
var ADMIN_PAGE_SIZE = 100;
var OR_ROOMS = ['OR 1', 'OR 2', 'OR 3', 'OR 4', 'Lasik', 'Laser', 'Scope 1', 'Scope 2'];
var ANESTHESIA_OPTIONS = ['LA', 'TPC', 'RB', 'BB', 'IVS', 'SB', 'EB', 'GA'];
var SURGICAL_WOUND_OPTIONS = ['No Wound', 'Clean Wound', 'Clean-Contaminated Wound', 'Contaminated Wound', 'Dirty Wound'];
var QUEUE_HEADERS = [
  'id', 'createdAt', 'updatedAt', 'date', 'time', 'hn', 'age', 'gender', 'wardOpd',
  'orRoom', 'diagnosis', 'operation', 'surgeon', 'anesthetist', 'anesthesia',
  'rights', 'comment', 'surgicalWound', 'surgeryTypes', 'checked', 'deletedAt'
];
var DATALIST_HEADERS = ['type', 'value', 'normalizedKey', 'createdAt'];
var ARCHIVE_LOG_HEADERS = ['archivedAt', 'sourceSheet', 'recordId', 'recordDate', 'archiveSheet'];
var SYNC_HEADERS = ['operationId', 'action', 'resultJson', 'createdAt'];
var DATALIST_TYPE_CONFIG = {
  diagnosis: { queueField: 'diagnosis', kind: 'scalar' },
  operation: { queueField: 'operation', kind: 'scalar' },
  surgeon: { queueField: 'surgeon', kind: 'scalar' },
  anesthetist: { queueField: 'anesthetist', kind: 'scalar' },
  rights: { queueField: 'rights', kind: 'scalar' },
  surgeryType: { queueField: 'surgeryTypes', kind: 'array' }
};

function ok_(data, meta) {
  return { ok: true, data: data == null ? null : data, error: null, meta: meta || {} };
}

function fail_(code, message, details) {
  return {
    ok: false,
    data: null,
    error: { code: code, message: message, details: details || {} },
    meta: {}
  };
}

function normalizeQueuePayload_(input) {
  var value = input || {};
  var text = function (key) {
    return String(value[key] == null ? '' : value[key]).trim().replace(/\s+/g, ' ');
  };
  var date = text('date');
  var time = text('time');
  var room = text('orRoom');
  var anesthesia = text('anesthesia');
  var gender = text('gender');
  ['hn', 'operation', 'surgeon'].forEach(function (key) {
    if (!text(key)) {
      throw new Error(key + ' is required');
    }
  });
  var ageText = text('age');
  var woundText = text('surgicalWound');
  var age = ageText ? Number(ageText) : '';
  var wound = woundText === '0' ? 'No Wound' : woundText;

  var dateParts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!dateParts) throw new Error('วันที่ไม่ถูกต้อง');
  var year = Number(dateParts[1]);
  var month = Number(dateParts[2]);
  var day = Number(dateParts[3]);
  var leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  var daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1]) {
    throw new Error('วันที่ไม่ถูกต้อง');
  }
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('เวลาไม่ถูกต้อง');
  if (room && OR_ROOMS.indexOf(room) < 0) throw new Error('OR Room ไม่ถูกต้อง');
  if (anesthesia && ANESTHESIA_OPTIONS.indexOf(anesthesia) < 0) throw new Error('Anesthesia ไม่ถูกต้อง');
  if (gender && ['ชาย', 'หญิง'].indexOf(gender) < 0) throw new Error('เพศไม่ถูกต้อง');
  if (ageText && (!Number.isInteger(age) || age < 0)) throw new Error('อายุไม่ถูกต้อง');
  if (wound && SURGICAL_WOUND_OPTIONS.indexOf(wound) < 0) throw new Error('Surgical Wound ไม่ถูกต้อง');

  return {
    date: date,
    time: time,
    hn: text('hn'),
    age: age,
    gender: gender,
    wardOpd: text('wardOpd'),
    orRoom: room,
    diagnosis: text('diagnosis'),
    operation: text('operation'),
    surgeon: text('surgeon'),
    anesthetist: text('anesthetist'),
    anesthesia: anesthesia,
    rights: text('rights'),
    comment: text('comment'),
    surgicalWound: wound,
    surgeryTypes: JSON.stringify(Array.isArray(value.surgeryTypes) ? value.surgeryTypes.map(String) : []),
    checked: value.checked === true
  };
}

function ensureSheet_(name, headers) {
  var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = spreadsheet.getSheetByName(name);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(name);
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    return sheet;
  }

  var actual = sheet.getLastColumn() ? sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0] : [];
  if (actual.length !== headers.length || actual.some(function (value, index) { return value !== headers[index]; })) {
    throw new Error('Sheet ' + name + ' has an invalid header order');
  }
  return sheet;
}

function setupOrSpreadsheet() {
  ensureSheet_(QUEUE_SHEET_NAME, QUEUE_HEADERS);
  ensureSheet_(DATALIST_SHEET_NAME, DATALIST_HEADERS);
  ensureSheet_(ARCHIVE_LOG_SHEET_NAME, ARCHIVE_LOG_HEADERS);
  ensureSheet_(SYNC_SHEET_NAME, SYNC_HEADERS);
  return ok_({
    queueSheet: QUEUE_SHEET_NAME,
    datalistSheet: DATALIST_SHEET_NAME,
    archiveLogSheet: ARCHIVE_LOG_SHEET_NAME
  });
}

function isValidDateKey_(value) {
  var match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  var year = Number(match[1]);
  var month = Number(match[2]);
  var day = Number(match[3]);
  var date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function normalizeScope_(request) {
  var value = request || {};
  var scope = String(value.scope || 'TODAY').toUpperCase();
  if (['TODAY', 'FUTURE', 'RANGE', 'ALL'].indexOf(scope) < 0) {
    throw new Error('scope 䁨¶١µ鍧');
  }
  var startDate = String(value.startDate || '');
  var endDate = String(value.endDate || '');
  if (scope === 'RANGE' &&
      (!isValidDateKey_(startDate) || !isValidDateKey_(endDate) || startDate > endDate)) {
    throw new Error('RANGE 䁨¶١µ鍧');
  }
  return { scope: scope, startDate: startDate, endDate: endDate };
}

function encodeCursor_(offset) { return String(Math.max(0, Math.floor(Number(offset) || 0))); }
function decodeCursor_(cursor) { return Math.max(0, Math.floor(Number(cursor) || 0)); }

function sortQueues_(items) {
  return items.slice().sort(function (a, b) {
    if (Boolean(a.checked) !== Boolean(b.checked)) return a.checked ? 1 : -1;
    var byDateTime = String(b.date + ' ' + b.time).localeCompare(String(a.date + ' ' + a.time), 'th');
    return byDateTime || String(b.id).localeCompare(String(a.id), 'th');
  });
}

function todayLocalDate_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function queueDateKey_(value) {
  if (Object.prototype.toString.call(value) === '[object Date]') {
    if (Number.isNaN(value.getTime())) return '';
    return Utilities.formatDate(value, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  return String(value == null ? '' : value).trim();
}

function queueTimeKey_(value) {
  if (Object.prototype.toString.call(value) === '[object Date]') {
    if (Number.isNaN(value.getTime())) return '';
    var offset = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'Z');
    var sign = offset.charAt(0) === '-' ? -1 : 1;
    var offsetMinutes = sign * (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(3, 5)));
    var totalMinutes = (value.getUTCHours() * 60 + value.getUTCMinutes() + offsetMinutes + 1440) % 1440;
    return String(Math.floor(totalMinutes / 60)).padStart(2, '0') + ':' + String(totalMinutes % 60).padStart(2, '0');
  }
  var text = String(value == null ? '' : value).trim();
  var direct = /^(?:[01]\d|2[0-3]):[0-5]\d/.exec(text);
  if (direct) return direct[0];
  var parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? text : queueTimeKey_(parsed);
}

function queueRowsFromSheet_(sheet) {
  var rowCount = sheet.getLastRow();
  if (rowCount < 2) return [];
  var values = sheet.getRange(1, 1, rowCount, QUEUE_HEADERS.length).getValues();
  var headers = values[0];
  return values.slice(1).map(function (valuesRow) {
    var item = {};
    headers.forEach(function (header, index) { item[header] = valuesRow[index]; });
    item.date = queueDateKey_(item.date);
    item.time = queueTimeKey_(item.time);
    item.checked = item.checked === true || item.checked === 'TRUE';
    return item;
  });
}

function queryQueueRows_(request) {
  var normalized = normalizeScope_(request);
  var today = todayLocalDate_();
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(QUEUE_SHEET_NAME);
  if (!sheet) return [];
  return sortQueues_(queueRowsFromSheet_(sheet).filter(function (item) {
    if (item.deletedAt) return false;
    if (normalized.scope === 'TODAY') return item.date === today;
    if (normalized.scope === 'FUTURE') return item.date > today;
    if (normalized.scope === 'RANGE') {
      return (!normalized.startDate || item.date >= normalized.startDate) &&
        (!normalized.endDate || item.date <= normalized.endDate);
    }
    return true;
  }));
}

function scriptCache_() {
  try {
    return CacheService.getScriptCache();
  } catch (error) {
    return null;
  }
}

function readCacheJson_(cache, key) {
  try {
    var cached = cache.get(key);
    return cached ? JSON.parse(cached) : null;
  } catch (error) {
    return null;
  }
}

function writeCacheJson_(cache, key, value, ttlSeconds) {
  try {
    cache.put(key, JSON.stringify(value), ttlSeconds);
  } catch (error) {}
}

function getQueues(request) {
  try {
    var normalized = normalizeScope_(request);
    var offset = decodeCursor_((request || {}).cursor);
    var today = todayLocalDate_();
    var cacheable = normalized.scope === 'TODAY' && offset === 0 && !(request || {}).fresh;
    var cache = cacheable ? scriptCache_() : null;
    var key = CACHE_PREFIX + 'today:' + today;
    if (cache) {
      var cached = readCacheJson_(cache, key);
      if (cached) return ok_(cached, { cached: true });
    }
    var rows = queryQueueRows_(normalized);
    var items = rows.slice(offset, offset + ADMIN_PAGE_SIZE);
    var nextOffset = offset + items.length;
    var data = { items: items, nextCursor: nextOffset < rows.length ? encodeCursor_(nextOffset) : null };
    if (cache) writeCacheJson_(cache, key, data, 45);
    return ok_(data, { cached: false });
  } catch (error) {
    return fail_('QUERY_FAILED', error.message, {});
  }
}

function normalizeDatalistKey_(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('th-TH');
}

function datalistTypeConfig_(type) {
  var normalizedType = String(type || '').trim();
  if (!Object.prototype.hasOwnProperty.call(DATALIST_TYPE_CONFIG, normalizedType)) {
    throw mutationError_('VALIDATION_FAILED', 'Datalist type is invalid');
  }
  var config = DATALIST_TYPE_CONFIG[normalizedType];
  return { type: normalizedType, config: config };
}

function normalizeDatalistValue_(value) {
  var normalized = String(value == null ? '' : value).trim().replace(/\s+/g, ' ');
  if (!normalizeDatalistKey_(normalized)) throw mutationError_('VALIDATION_FAILED', 'Datalist value is required');
  return normalized;
}

function normalizeDatalistOptionRequest_(request, requiresOldKey) {
  var value = request || {};
  var typeInfo = datalistTypeConfig_(value.type);
  var normalizedValue = normalizeDatalistValue_(value.value);
  var oldKey = normalizeDatalistKey_(value.normalizedKey);
  if (requiresOldKey && !oldKey) throw mutationError_('VALIDATION_FAILED', 'Datalist normalizedKey is required');
  return {
    type: typeInfo.type,
    config: typeInfo.config,
    value: normalizedValue,
    normalizedKey: normalizeDatalistKey_(normalizedValue),
    oldKey: oldKey
  };
}

function datalistRowsFromSheet_(sheet) {
  if (!sheet || sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, DATALIST_HEADERS.length).getValues()
    .map(function (row, index) {
      var type = String(row[0] == null ? '' : row[0]).trim();
      var value = String(row[1] == null ? '' : row[1]).trim();
      var normalizedKey = String(row[2] == null ? '' : row[2]).trim() || normalizeDatalistKey_(value);
      if (!Object.prototype.hasOwnProperty.call(DATALIST_TYPE_CONFIG, type) || !value || !normalizedKey) return null;
      return {
        rowNumber: index + 2,
        type: type,
        value: value,
        normalizedKey: normalizedKey,
        createdAt: row[3]
      };
    })
    .filter(function (row) { return row !== null; });
}

function datalistEntryPayload_(row) {
  return {
    type: row.type,
    value: row.value,
    normalizedKey: row.normalizedKey,
    createdAt: String(row.createdAt == null ? '' : row.createdAt)
  };
}

function datalistRowsForKey_(rows, type, normalizedKey) {
  return rows.filter(function (row) {
    return row.type === type && row.normalizedKey === normalizedKey;
  });
}

function syncDatalistValueInQueues_(type, oldKey, nextValue, removeValue) {
  var config = DATALIST_TYPE_CONFIG[type];
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(QUEUE_SHEET_NAME);
  if (!config || !sheet || sheet.getLastRow() < 2) return 0;

  var rowCount = sheet.getLastRow();
  var rows = sheet.getRange(2, 1, rowCount - 1, QUEUE_HEADERS.length).getValues();
  var fieldIndex = QUEUE_HEADERS.indexOf(config.queueField);
  var updatedAtIndex = QUEUE_HEADERS.indexOf('updatedAt');
  var changedRows = 0;
  var changedAt = nowIso_();

  rows.forEach(function (row) {
    if (config.kind === 'scalar') {
      var currentValue = String(row[fieldIndex] == null ? '' : row[fieldIndex]).trim();
      if (normalizeDatalistKey_(currentValue) !== oldKey) return;
      row[fieldIndex] = removeValue ? '' : nextValue;
      row[updatedAtIndex] = changedAt;
      changedRows += 1;
      return;
    }

    var parsed;
    try { parsed = JSON.parse(String(row[fieldIndex] || '[]')); } catch (error) { return; }
    if (!Array.isArray(parsed)) return;
    var changed = false;
    var next = [];
    parsed.forEach(function (item) {
      var text = String(item == null ? '' : item).trim();
      if (normalizeDatalistKey_(text) !== oldKey) {
        next.push(text);
        return;
      }
      changed = true;
      if (!removeValue) next.push(nextValue);
    });
    if (!changed) return;
    row[fieldIndex] = JSON.stringify(next);
    row[updatedAtIndex] = changedAt;
    changedRows += 1;
  });

  if (changedRows) sheet.getRange(2, 1, rows.length, QUEUE_HEADERS.length).setValues(rows);
  return changedRows;
}

function assertUuid_(value) {
  var id = String(value || '').trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw new Error('UUID is invalid');
  return id;
}

function collectDatalistEntries_(queue) {
  var pairs = [['diagnosis', queue.diagnosis], ['operation', queue.operation], ['surgeon', queue.surgeon], ['anesthetist', queue.anesthetist], ['rights', queue.rights]];
  JSON.parse(queue.surgeryTypes || '[]').forEach(function (value) { pairs.push(['surgeryType', value]); });
  return pairs.filter(function (pair) {
    return normalizeDatalistKey_(pair[1]) && String(pair[1]).trim() !== '-';
  }).map(function (pair) { return { type: pair[0], value: String(pair[1]).trim() }; });
}

function mutationError_(code, message) {
  var error = new Error(message);
  error.code = code;
  return error;
}

function mutationFailure_(error) {
  return fail_(error && error.code ? error.code : 'VALIDATION_FAILED', error && error.message ? error.message : 'Mutation failed', {});
}

function nowIso_() { return new Date().toISOString(); }
function queueValues_(queue) { return QUEUE_HEADERS.map(function (header) { return queue[header]; }); }
function writeQueueRow_(sheet, rowNumber, queue) { sheet.getRange(rowNumber, 1, 1, QUEUE_HEADERS.length).setValues([queueValues_(queue)]); }

function findActiveQueueRow_(sheet, id) {
  var rows = queueRowsFromSheet_(sheet);
  for (var index = 0; index < rows.length; index += 1) {
    if (String(rows[index].id) === id && !rows[index].deletedAt) return { rowNumber: index + 2, queue: rows[index] };
  }
  throw mutationError_('NOT_FOUND', 'Queue not found');
}

function withScriptLock_(work) {
  var lock = LockService.getScriptLock();
  var acquired = false;
  try {
    lock.waitLock(30000);
    acquired = true;
    return work();
  } finally {
    if (acquired) lock.releaseLock();
  }
}

function invalidateOrCache_() {
  var cache = scriptCache_();
  if (!cache) return;
  try { cache.remove(CACHE_PREFIX + 'today:' + todayLocalDate_()); } catch (error) {}
}

function rememberDatalistValues_(queue) {
  var sheet = ensureSheet_(DATALIST_SHEET_NAME, DATALIST_HEADERS);
  var existing = {};
  var rowCount = sheet.getLastRow();
  if (rowCount >= 2) {
    sheet.getRange(2, 1, rowCount - 1, DATALIST_HEADERS.length).getValues().forEach(function (row) {
      existing[String(row[0]) + ':' + String(row[2])] = true;
    });
  }
  var newRows = [];
  collectDatalistEntries_(queue).forEach(function (entry) {
    var normalizedKey = normalizeDatalistKey_(entry.value);
    var key = entry.type + ':' + normalizedKey;
    if (!existing[key]) {
      existing[key] = true;
      newRows.push([entry.type, entry.value, normalizedKey, nowIso_()]);
    }
  });
  if (newRows.length) sheet.getRange(rowCount + 1, 1, newRows.length, DATALIST_HEADERS.length).setValues(newRows);
}

function getDatalistOptions() {
  try {
    var options = { diagnosis: [], operation: [], surgeon: [], anesthetist: [], rights: [], surgeryType: [] };
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(DATALIST_SHEET_NAME);
    if (!sheet || sheet.getLastRow() < 2) return ok_(options);
    var seen = {};
    sheet.getRange(2, 1, sheet.getLastRow() - 1, DATALIST_HEADERS.length).getValues().forEach(function (row) {
      var type = String(row[0]);
      var value = String(row[1]).trim();
      var normalizedKey = String(row[2]) || normalizeDatalistKey_(value);
      var key = type + ':' + normalizedKey;
      if (Object.prototype.hasOwnProperty.call(options, type) && value && !seen[key]) {
        seen[key] = true;
        options[type].push(value);
      }
    });
    Object.keys(options).forEach(function (type) { options[type].sort(function (left, right) { return left.localeCompare(right, 'th'); }); });
    return ok_(options);
  } catch (error) {
    return fail_('DATALIST_READ_FAILED', error.message, {});
  }
}

function getDatalistEntries() {
  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(DATALIST_SHEET_NAME);
    var items = datalistRowsFromSheet_(sheet).map(datalistEntryPayload_);
    items.sort(function (left, right) {
      return String(left.type).localeCompare(String(right.type), 'th') ||
        String(left.value).localeCompare(String(right.value), 'th');
    });
    return ok_({ items: items });
  } catch (error) {
    return fail_('DATALIST_READ_FAILED', error.message, {});
  }
}

function createDatalistOption(request) {
  try {
    return withScriptLock_(function () {
      var normalized = normalizeDatalistOptionRequest_(request, false);
      var sheet = ensureSheet_(DATALIST_SHEET_NAME, DATALIST_HEADERS);
      var rows = datalistRowsFromSheet_(sheet);
      if (rows.some(function (row) {
        return row.type === normalized.type && row.normalizedKey === normalized.normalizedKey;
      })) {
        throw mutationError_('DUPLICATE_DATALIST_OPTION', 'Datalist option already exists');
      }
      var createdAt = nowIso_();
      sheet.getRange(sheet.getLastRow() + 1, 1, 1, DATALIST_HEADERS.length)
        .setValues([[normalized.type, normalized.value, normalized.normalizedKey, createdAt]]);
      return ok_({
        item: { type: normalized.type, value: normalized.value, normalizedKey: normalized.normalizedKey, createdAt: createdAt },
        affectedOptionRows: 1,
        affectedQueueRows: 0
      });
    });
  } catch (error) { return mutationFailure_(error); }
}

function updateDatalistOption(request) {
  try {
    return withScriptLock_(function () {
      var normalized = normalizeDatalistOptionRequest_(request, true);
      var sheet = ensureSheet_(DATALIST_SHEET_NAME, DATALIST_HEADERS);
      var rows = datalistRowsFromSheet_(sheet);
      var matches = datalistRowsForKey_(rows, normalized.type, normalized.oldKey);
      if (!matches.length) throw mutationError_('NOT_FOUND', 'Datalist option not found');
      if (rows.some(function (row) {
        return row.type === normalized.type && row.normalizedKey === normalized.normalizedKey && row.normalizedKey !== normalized.oldKey;
      })) {
        throw mutationError_('DUPLICATE_DATALIST_OPTION', 'Datalist option already exists');
      }

      matches.forEach(function (row) {
        sheet.getRange(row.rowNumber, 1, 1, DATALIST_HEADERS.length)
          .setValues([[normalized.type, normalized.value, normalized.normalizedKey, row.createdAt]]);
      });
      var affectedQueueRows = syncDatalistValueInQueues_(normalized.type, normalized.oldKey, normalized.value, false);
      if (affectedQueueRows) invalidateOrCache_();
      return ok_({
        item: {
          type: normalized.type,
          value: normalized.value,
          normalizedKey: normalized.normalizedKey,
          createdAt: String(matches[0].createdAt == null ? '' : matches[0].createdAt)
        },
        affectedOptionRows: matches.length,
        affectedQueueRows: affectedQueueRows
      });
    });
  } catch (error) { return mutationFailure_(error); }
}

function deleteDatalistOption(request) {
  try {
    return withScriptLock_(function () {
      var normalized = normalizeDatalistOptionRequest_(Object.assign({}, request || {}, { value: 'delete' }), true);
      var sheet = ensureSheet_(DATALIST_SHEET_NAME, DATALIST_HEADERS);
      var rows = datalistRowsFromSheet_(sheet);
      var matches = datalistRowsForKey_(rows, normalized.type, normalized.oldKey);
      if (!matches.length) throw mutationError_('NOT_FOUND', 'Datalist option not found');

      var affectedQueueRows = syncDatalistValueInQueues_(normalized.type, normalized.oldKey, '', true);
      matches.slice().sort(function (left, right) { return right.rowNumber - left.rowNumber; })
        .forEach(function (row) { sheet.deleteRow(row.rowNumber); });
      if (affectedQueueRows) invalidateOrCache_();
      return ok_({
        item: datalistEntryPayload_(matches[0]),
        affectedOptionRows: matches.length,
        affectedQueueRows: affectedQueueRows
      });
    });
  } catch (error) { return mutationFailure_(error); }
}

function createQueue(payload) {
  try {
    return withScriptLock_(function () {
      var normalized = normalizeQueuePayload_(payload);
      var now = nowIso_();
      var requestedId = payload && payload.id ? assertUuid_(payload.id) : assertUuid_(Utilities.getUuid());
      var queue = Object.assign({}, normalized, { id: requestedId, createdAt: now, updatedAt: now, deletedAt: '' });
      var sheet = ensureSheet_(QUEUE_SHEET_NAME, QUEUE_HEADERS);
      rememberDatalistValues_(queue);
      writeQueueRow_(sheet, sheet.getLastRow() + 1, queue);
      invalidateOrCache_();
      return ok_(queue);
    });
  } catch (error) { return mutationFailure_(error); }
}

function updateQueue(payload) {
  try {
    return withScriptLock_(function () {
      var id = assertUuid_((payload || {}).id);
      var normalized = normalizeQueuePayload_(payload);
      var sheet = ensureSheet_(QUEUE_SHEET_NAME, QUEUE_HEADERS);
      var existing = findActiveQueueRow_(sheet, id);
      var queue = Object.assign({}, normalized, { id: id, createdAt: existing.queue.createdAt, updatedAt: nowIso_(), deletedAt: '' });
      rememberDatalistValues_(queue);
      writeQueueRow_(sheet, existing.rowNumber, queue);
      invalidateOrCache_();
      return ok_(queue);
    });
  } catch (error) { return mutationFailure_(error); }
}

function deleteQueue(request) {
  try {
    return withScriptLock_(function () {
      var id = assertUuid_((request || {}).id);
      var sheet = ensureSheet_(QUEUE_SHEET_NAME, QUEUE_HEADERS);
      var existing = findActiveQueueRow_(sheet, id);
      var now = nowIso_();
      var queue = Object.assign({}, existing.queue, { updatedAt: now, deletedAt: now });
      writeQueueRow_(sheet, existing.rowNumber, queue);
      invalidateOrCache_();
      return ok_(queue);
    });
  } catch (error) { return mutationFailure_(error); }
}

function setQueueStatus(request) {
  try {
    return withScriptLock_(function () {
      var value = request || {};
      var id = assertUuid_(value.id);
      if (typeof value.checked !== 'boolean') throw mutationError_('VALIDATION_FAILED', 'Status is invalid');
      var sheet = ensureSheet_(QUEUE_SHEET_NAME, QUEUE_HEADERS);
      var existing = findActiveQueueRow_(sheet, id);
      var queue = Object.assign({}, existing.queue, { checked: value.checked, updatedAt: nowIso_() });
      writeQueueRow_(sheet, existing.rowNumber, queue);
      invalidateOrCache_();
      return ok_(queue);
    });
  } catch (error) { return mutationFailure_(error); }
}

function apiJson_(result, requestId) {
  var body = result || fail_('API_EMPTY_RESPONSE', 'API returned no response', {});
  return ContentService.createTextOutput(JSON.stringify({
    ok: body.ok === true,
    data: body.data == null ? null : body.data,
    error: body.error || null,
    meta: body.meta || {},
    requestId: requestId,
    serverTime: nowIso_()
  })).setMimeType(ContentService.MimeType.JSON);
}

function apiRequest_(e, method) {
  var event = e || {};
  var parameter = event.parameter || {};
  var body = {};
  if (method === 'POST') {
    var contents = event.postData && event.postData.contents ? event.postData.contents : '{}';
    body = JSON.parse(contents);
  }
  var action = String(body.action || parameter.action || '').trim();
  var rawPayload = body.payload != null ? body.payload : parameter.payload;
  var payload = rawPayload == null || rawPayload === '' ? {} : rawPayload;
  if (typeof payload === 'string') payload = JSON.parse(payload);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw mutationError_('API_REQUEST_INVALID', 'API payload must be an object');
  }
  return {
    action: action,
    payload: payload,
    operationId: String(body.operationId || parameter.operationId || '').trim()
  };
}

function apiDispatch_(action, payload) {
  var normalizedAction = String(action || '').trim();
  var value = payload || {};
  switch (normalizedAction) {
    case 'getQueues': return getQueues(value);
    case 'getDatalistOptions': return getDatalistOptions();
    case 'getDatalistEntries': return getDatalistEntries();
    case 'createQueue': return createQueue(value);
    case 'updateQueue': return updateQueue(value);
    case 'deleteQueue': return deleteQueue(value);
    case 'setQueueStatus': return setQueueStatus(value);
    case 'createDatalistOption': return createDatalistOption(value);
    case 'updateDatalistOption': return updateDatalistOption(value);
    case 'deleteDatalistOption': return deleteDatalistOption(value);
    case 'exportQueues': return exportQueues(value);
    default: return fail_('API_ACTION_NOT_ALLOWED', 'API action is not allowed', { action: normalizedAction });
  }
}

function normalizeOperationId_(value) {
  try {
    return assertUuid_(value);
  } catch (error) {
    throw mutationError_('API_OPERATION_ID_INVALID', 'operationId must be a UUID');
  }
}

function withOperationId_(operationId, action, work) {
  var normalizedId = normalizeOperationId_(operationId);
  var sheet = ensureSheet_(SYNC_SHEET_NAME, SYNC_HEADERS);
  if (sheet.getLastRow() >= 2) {
    var rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, SYNC_HEADERS.length).getValues();
    for (var index = 0; index < rows.length; index += 1) {
      if (String(rows[index][0]) !== normalizedId) continue;
      try { return JSON.parse(String(rows[index][2] || 'null')); } catch (error) {
        throw mutationError_('SYNC_RESULT_INVALID', 'Stored sync result is invalid');
      }
    }
  }
  var result = work();
  sheet.getRange(sheet.getLastRow() + 1, 1, 1, SYNC_HEADERS.length)
    .setValues([[normalizedId, String(action || ''), JSON.stringify(result), nowIso_()]]);
  return result;
}

function doGet(e) {
  var parameter = e && e.parameter ? e.parameter : {};
  if (String(parameter.api || '') === '1') {
    var requestId = Utilities.getUuid();
    try {
      var request = apiRequest_(e, 'GET');
      return apiJson_(apiDispatch_(request.action, request.payload), requestId);
    } catch (error) {
      return apiJson_(fail_(error && error.code ? error.code : 'API_REQUEST_INVALID', error && error.message ? error.message : 'Invalid API request', {}), requestId);
    }
  }
  var requestedPage = e && e.parameter ? String(e.parameter.page || '').toLowerCase() : '';
  var page = requestedPage === 'admin' ? ADMIN_PAGE_NAME : DASHBOARD_PAGE_NAME;
  return HtmlService.createTemplateFromFile(page).evaluate()
    .setTitle(page === ADMIN_PAGE_NAME ? 'OR Admin' : 'OR Dashboard')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
}

function doPost(e) {
  var requestId = Utilities.getUuid();
  try {
    var request = apiRequest_(e, 'POST');
    if (!request.operationId) {
      return apiJson_(fail_('API_OPERATION_ID_REQUIRED', 'operationId is required', {}), requestId);
    }
    var result = withScriptLock_(function () {
      return withOperationId_(request.operationId, request.action, function () {
        return apiDispatch_(request.action, request.payload);
      });
    });
    return apiJson_(result, requestId);
  } catch (error) {
    return apiJson_(fail_(error && error.code ? error.code : 'API_REQUEST_INVALID', error && error.message ? error.message : 'Invalid API request', {}), requestId);
  }
}

function sanitizeCsvCell_(value) {
  var text = String(value == null ? '' : value);
  var first = text.charAt(0);
  return first === '=' || first === '+' || first === '-' || first === '@' ||
    text.charCodeAt(0) === 9 || text.charCodeAt(0) === 13 ? "'" + text : text;
}

function dateFromKey_(dateKey) {
  var parts = String(dateKey || '').split('-');
  if (parts.length !== 3 || parts[0].length !== 4 || parts[1].length !== 2 || parts[2].length !== 2) return null;
  var year = Number(parts[0]);
  var month = Number(parts[1]);
  var day = Number(parts[2]);
  var date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null;
}

function isArchiveCandidate_(dateKey, now) {
  var date = dateFromKey_(dateKey);
  if (!date) return false;
  var current = now || new Date();
  var cutoff = new Date(current.getFullYear(), current.getMonth(), current.getDate() - ACTIVE_RETENTION_DAYS);
  return date < cutoff;
}

function archiveToday_() {
  var today = dateFromKey_(todayLocalDate_());
  if (!today) throw new Error('Current date is invalid');
  return today;
}

function archiveRowsByYear_(rows, today) {
  var idCounts = {};
  rows.forEach(function (entry) {
    var id = String(entry.queue.id || '');
    if (id) idCounts[id] = (idCounts[id] || 0) + 1;
  });
  var groups = {};
  rows.forEach(function (entry) {
    var id = String(entry.queue.id || '');
    if (!id || idCounts[id] !== 1 || !isArchiveCandidate_(entry.queue.date, today)) return;
    var year = String(entry.queue.date).slice(0, 4);
    if (!groups[year]) groups[year] = [];
    groups[year].push(entry);
  });
  return groups;
}

function sheetRowsWithNumbers_(sheet) {
  return queueRowsFromSheet_(sheet).map(function (queue, index) {
    return { rowNumber: index + 2, queue: queue };
  });
}

function appendQueueRows_(sheet, queues) {
  if (!queues.length) return;
  sheet.getRange(sheet.getLastRow() + 1, 1, queues.length, QUEUE_HEADERS.length)
    .setValues(queues.map(queueValues_));
}

function archiveLogRecordIds_(sheet) {
  var ids = {};
  if (sheet.getLastRow() < 2) return ids;
  sheet.getRange(2, 1, sheet.getLastRow() - 1, ARCHIVE_LOG_HEADERS.length).getValues()
    .forEach(function (row) { ids[String(row[2] || '')] = true; });
  return ids;
}

function appendArchiveLog_(sheet, moved, loggedIds) {
  var rows = moved.filter(function (entry) { return !loggedIds[String(entry.queue.id)]; })
    .map(function (entry) {
      loggedIds[String(entry.queue.id)] = true;
      return [nowIso_(), QUEUE_SHEET_NAME, entry.queue.id, entry.queue.date, 'Queues_Archive_' + String(entry.queue.date).slice(0, 4)];
    });
  if (rows.length) sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, ARCHIVE_LOG_HEADERS.length).setValues(rows);
}

function previewArchivePlan() {
  try {
    return ok_(archivePlan_());
  } catch (error) {
    return fail_('ARCHIVE_PREVIEW_FAILED', error.message, {});
  }
}

function installArchiveTrigger() {
  try {
    ScriptApp.getProjectTriggers().forEach(function (trigger) {
      if (trigger.getHandlerFunction() === 'runArchiveJob') ScriptApp.deleteTrigger(trigger);
    });
    ScriptApp.newTrigger('runArchiveJob').timeBased().everyDays(1).atHour(2).create();
    return ok_({ handler: 'runArchiveJob', schedule: 'daily' });
  } catch (error) {
    return fail_('ARCHIVE_TRIGGER_FAILED', error.message, {});
  }
}

function sanitizeQueueForExport_(queue) {
  var copy = {};
  QUEUE_HEADERS.forEach(function (header) { copy[header] = sanitizeCsvCell_(queue[header]); });
  return copy;
}

function exportQueues(request) {
  try {
    var offset = decodeCursor_((request || {}).cursor);
    var rows = queryQueueRows_(request || {});
    var items = rows.slice(offset, offset + ADMIN_PAGE_SIZE).map(sanitizeQueueForExport_);
    var nextOffset = offset + items.length;
    return ok_({
      headers: QUEUE_HEADERS.slice(),
      items: items,
      nextCursor: nextOffset < rows.length ? encodeCursor_(nextOffset) : null
    });
  } catch (error) {
    return fail_('EXPORT_FAILED', error.message, {});
  }
}
function archiveCutoffDateKey_(today) {
  return queueDateKey_(new Date(today.getFullYear(), today.getMonth(), today.getDate() - ACTIVE_RETENTION_DAYS));
}

function archivePlan_() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(QUEUE_SHEET_NAME);
  var today = archiveToday_();
  var groups = archiveRowsByYear_(sheet ? sheetRowsWithNumbers_(sheet) : [], today);
  var archivedByYear = {};
  Object.keys(groups).forEach(function (year) { archivedByYear[year] = groups[year].length; });
  return { cutoffDate: archiveCutoffDateKey_(today), archivedByYear: archivedByYear };
}

function deleteArchivedSourceRows_(sheet, moved, onMutation) {
  var sorted = moved.slice().sort(function (left, right) { return right.rowNumber - left.rowNumber; });
  var ranges = [];
  sorted.forEach(function (entry) {
    var current = ranges[ranges.length - 1];
    if (current && entry.rowNumber === current.startRow - 1) {
      current.startRow = entry.rowNumber;
      current.rowCount += 1;
    } else {
      ranges.push({ startRow: entry.rowNumber, rowCount: 1 });
    }
  });
  ranges.forEach(function (range) {
    sheet.deleteRows(range.startRow, range.rowCount);
    onMutation();
  });
}

function runArchiveJob() {
  var sourceMutated = false;
  try {
    return withScriptLock_(function () {
      var activeSheet = ensureSheet_(QUEUE_SHEET_NAME, QUEUE_HEADERS);
      var logSheet = ensureSheet_(ARCHIVE_LOG_SHEET_NAME, ARCHIVE_LOG_HEADERS);
      var groups = archiveRowsByYear_(sheetRowsWithNumbers_(activeSheet), archiveToday_());
      var moved = [];
      var archivedByYear = {};

      Object.keys(groups).sort().forEach(function (year) {
        var candidates = groups[year];
        var archiveSheet = ensureSheet_('Queues_Archive_' + year, QUEUE_HEADERS);
        var destinationIds = {};
        queueRowsFromSheet_(archiveSheet).forEach(function (queue) { destinationIds[String(queue.id || '')] = true; });
        var toAppend = candidates.filter(function (entry) { return !destinationIds[String(entry.queue.id)]; });
        appendQueueRows_(archiveSheet, toAppend.map(function (entry) { return entry.queue; }));
        queueRowsFromSheet_(archiveSheet).forEach(function (queue) { destinationIds[String(queue.id || '')] = true; });
        var verified = candidates.filter(function (entry) { return destinationIds[String(entry.queue.id)]; });
        if (verified.length) {
          archivedByYear[year] = verified.length;
          moved = moved.concat(verified);
        }
      });

      appendArchiveLog_(logSheet, moved, archiveLogRecordIds_(logSheet));
      deleteArchivedSourceRows_(activeSheet, moved, function () { sourceMutated = true; });
      return ok_({ archivedByYear: archivedByYear });
    });
  } catch (error) {
    return fail_('ARCHIVE_FAILED', error.message, {});
  } finally {
    if (sourceMutated) {
      try { invalidateOrCache_(); } catch (ignore) {}
    }
  }
}
