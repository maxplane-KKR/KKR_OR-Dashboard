(function (global) {
  'use strict';

  var DB_NAME = 'orq-dashboard';
  var DB_VERSION = 1;
  var STORE_NAMES = { snapshots: 'snapshots', outbox: 'outbox', meta: 'meta' };

  function StorageError(code, message, details) {
    this.name = 'StorageError';
    this.code = code;
    this.message = message || code;
    this.details = details || {};
  }
  StorageError.prototype = Object.create(Error.prototype);
  StorageError.prototype.constructor = StorageError;

  function createOrStore(options) {
    var settings = options || {};
    var indexedDBApi = Object.prototype.hasOwnProperty.call(settings, 'indexedDB')
      ? settings.indexedDB
      : global.indexedDB;
    var dbName = settings.dbName || DB_NAME;
    var now = settings.now || function () { return new Date().toISOString(); };
    var databasePromise = null;

    function openDatabase() {
      if (databasePromise) return databasePromise;
      if (!indexedDBApi || typeof indexedDBApi.open !== 'function') {
        return Promise.reject(new StorageError('STORAGE_UNAVAILABLE', 'ไม่พบ IndexedDB ใน browser'));
      }
      databasePromise = new Promise(function (resolve, reject) {
        var request;
        try { request = indexedDBApi.open(dbName, DB_VERSION); } catch (error) {
          reject(new StorageError('STORAGE_UNAVAILABLE', error.message));
          return;
        }
        request.onupgradeneeded = function (event) {
          var db = event.target.result;
          if (!db.objectStoreNames.contains(STORE_NAMES.snapshots)) db.createObjectStore(STORE_NAMES.snapshots, { keyPath: 'key' });
          if (!db.objectStoreNames.contains(STORE_NAMES.outbox)) db.createObjectStore(STORE_NAMES.outbox, { keyPath: 'operationId' });
          if (!db.objectStoreNames.contains(STORE_NAMES.meta)) db.createObjectStore(STORE_NAMES.meta, { keyPath: 'key' });
        };
        request.onsuccess = function (event) { resolve(event.target.result); };
        request.onerror = function (event) {
          databasePromise = null;
          reject(new StorageError('STORAGE_UNAVAILABLE', event.target.error && event.target.error.message));
        };
      });
      return databasePromise;
    }

    function requestValue(storeName, method, value) {
      return openDatabase().then(function (db) {
        return new Promise(function (resolve, reject) {
          var request;
          try {
            var store = db.transaction(storeName, method === 'get' || method === 'getAll' ? 'readonly' : 'readwrite').objectStore(storeName);
            if (method === 'getAll') request = store.getAll();
            else if (method === 'get') request = store.get(value);
            else if (method === 'put') request = store.put(value);
            else if (method === 'delete') request = store.delete(value);
            else throw new Error('Unsupported storage operation');
          } catch (error) {
            reject(new StorageError('STORAGE_OPERATION_FAILED', error.message));
            return;
          }
          request.onsuccess = function (event) { resolve(event.target.result); };
          request.onerror = function (event) {
            reject(new StorageError('STORAGE_OPERATION_FAILED', event.target.error && event.target.error.message));
          };
        });
      });
    }

    function getSnapshot(key) { return requestValue(STORE_NAMES.snapshots, 'get', String(key)); }

    function putSnapshot(key, value) {
      var record = { key: String(key), value: value, savedAt: now() };
      return requestValue(STORE_NAMES.snapshots, 'put', record).then(function () { return record; });
    }

    function enqueueMutation(item) {
      var input = item || {};
      var operationId = String(input.operationId || '').trim();
      if (!operationId) return Promise.reject(new StorageError('OPERATION_ID_REQUIRED', 'operationId is required'));
      return requestValue(STORE_NAMES.outbox, 'get', operationId).then(function (existing) {
        if (existing) return existing;
        var record = Object.assign({
          createdAt: now(), attempts: 0, status: 'pending', lastError: ''
        }, input, { operationId: operationId });
        return requestValue(STORE_NAMES.outbox, 'put', record).then(function () { return record; });
      });
    }

    function listPendingMutations() {
      return requestValue(STORE_NAMES.outbox, 'getAll').then(function (items) {
        return (items || []).filter(function (item) { return item.status !== 'done' && item.status !== 'conflict'; })
          .sort(function (left, right) { return String(left.createdAt).localeCompare(String(right.createdAt)); });
      });
    }

    function updateMutation(operationId, patch) {
      var id = String(operationId || '').trim();
      return requestValue(STORE_NAMES.outbox, 'get', id).then(function (existing) {
        if (!existing) throw new StorageError('OUTBOX_NOT_FOUND', 'ไม่พบ operation ใน outbox');
        var record = Object.assign({}, existing, patch || {}, { operationId: id });
        return requestValue(STORE_NAMES.outbox, 'put', record).then(function () { return record; });
      });
    }

    function removeMutation(operationId) {
      return requestValue(STORE_NAMES.outbox, 'delete', String(operationId || '').trim()).then(function () { return true; });
    }

    function getMeta(key) { return requestValue(STORE_NAMES.meta, 'get', String(key)); }

    function putMeta(key, value) {
      var record = { key: String(key), value: value, savedAt: now() };
      return requestValue(STORE_NAMES.meta, 'put', record).then(function () { return record; });
    }

    return {
      getSnapshot: getSnapshot,
      putSnapshot: putSnapshot,
      enqueueMutation: enqueueMutation,
      listPendingMutations: listPendingMutations,
      updateMutation: updateMutation,
      removeMutation: removeMutation,
      getMeta: getMeta,
      putMeta: putMeta,
    };
  }

  global.OrStorageError = StorageError;
  global.createOrStore = createOrStore;
}(typeof globalThis === 'undefined' ? this : globalThis));
