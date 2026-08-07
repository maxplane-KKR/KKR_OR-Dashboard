(function (global) {
  'use strict';

  function SyncError(code, message, details) {
    this.name = 'SyncError';
    this.code = code;
    this.message = message || code;
    this.details = details || {};
  }
  SyncError.prototype = Object.create(Error.prototype);
  SyncError.prototype.constructor = SyncError;

  function createOrSyncManager(options) {
    var settings = options || {};
    var store = settings.store;
    var apiClient = settings.apiClient;
    var now = settings.now || function () { return new Date().toISOString(); };
    var online = settings.online || function () {
      return !global.navigator || global.navigator.onLine !== false;
    };
    var clientIdFactory = settings.clientIdFactory || function () {
      if (global.crypto && typeof global.crypto.randomUUID === 'function') return global.crypto.randomUUID();
      var template = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx';
      return template.replace(/[xy]/g, function (character) {
        var random = Math.random() * 16 | 0;
        var value = character === 'x' ? random : (random & 0x3 | 0x8);
        return value.toString(16);
      });
    };
    var operationIdFactory = settings.operationIdFactory || function () {
      if (global.crypto && typeof global.crypto.randomUUID === 'function') return global.crypto.randomUUID();
      return 'op-' + Date.now() + '-' + Math.random().toString(16).slice(2);
    };
    var status = online() ? 'online' : 'offline';
    var listeners = [];
    var flushPromise = null;

    function isOnline() {
      try { return Boolean(online()); } catch (error) { return false; }
    }

    function notify(nextStatus, details) {
      status = nextStatus;
      listeners.slice().forEach(function (listener) {
        try { listener({ status: status, details: details || {} }); } catch (error) {}
      });
    }

    function snapshotResult(snapshot, meta) {
      return { ok: true, data: snapshot.value, error: null, meta: Object.assign({}, meta || {}, {
        cached: true,
        savedAt: snapshot.savedAt || ''
      }) };
    }

    function loadSnapshot(key, loader) {
      return store.getSnapshot(key).then(function (snapshot) {
        if (!isOnline()) {
          notify('offline');
          if (!snapshot) throw new SyncError('OFFLINE_NO_SNAPSHOT', 'ไม่มีข้อมูลที่บันทึกไว้ในเครื่อง');
          return snapshotResult(snapshot, { offline: true });
        }
        notify('syncing');
        return Promise.resolve().then(loader).then(function (response) {
          if (!response || typeof response.ok !== 'boolean') throw new SyncError('RESPONSE_INVALID', 'ข้อมูลจาก API ไม่ถูกต้อง');
          if (!response.ok) {
            if (snapshot) return snapshotResult(snapshot, { stale: true, serverError: response.error });
            throw new SyncError(response.error && response.error.code || 'API_ERROR', response.error && response.error.message || 'โหลดข้อมูลไม่สำเร็จ');
          }
          return store.putSnapshot(key, response.data).then(function (saved) {
            notify('online');
            return { ok: true, data: response.data, error: null, meta: Object.assign({}, response.meta || {}, { cached: false, savedAt: saved.savedAt }) };
          });
        }).catch(function (error) {
          if (snapshot && error && ['NETWORK_ERROR', 'HTTP_ERROR', 'API_UNAVAILABLE'].indexOf(error.code) >= 0) {
            notify('offline', { error: error });
            return snapshotResult(snapshot, { stale: true, offline: true });
          }
          notify('error', { error: error });
          throw error;
        });
      });
    }

    function queueMutation(action, payload, baseUpdatedAt, requestOptions) {
      var operationId = String((requestOptions || {}).operationId || operationIdFactory());
      var createdAt = (requestOptions || {}).createdAt || now();
      var mutationPayload = Object.assign({}, payload || {});
      if (action === 'createQueue' && !mutationPayload.id) {
        mutationPayload.id = String(clientIdFactory());
        mutationPayload.createdAt = createdAt;
        mutationPayload.updatedAt = createdAt;
        mutationPayload.deletedAt = '';
      }
      var item = Object.assign({}, requestOptions || {}, {
        operationId: operationId,
        action: action,
        payload: mutationPayload,
        baseUpdatedAt: baseUpdatedAt || '',
        createdAt: createdAt,
        status: 'pending',
        attempts: 0,
        lastError: ''
      });
      return store.enqueueMutation(item).then(function (saved) {
        if (!isOnline()) {
          notify('offline', { pending: true });
          return { ok: true, data: mutationPayload, error: null, meta: { pending: true, offline: true } };
        }
        notify('pending', { pending: true });
        return flush().then(function (results) {
          var matched = results.filter(function (result) { return result.operationId === saved.operationId; })[0];
          return matched ? matched.response : { ok: true, data: mutationPayload, error: null, meta: { pending: true } };
        });
      });
    }

    function markRetry(item, error) {
      var attempts = Number(item.attempts || 0) + 1;
      var message = error && error.message ? error.message : 'sync ไม่สำเร็จ';
      return store.updateMutation(item.operationId, {
        attempts: attempts,
        status: 'retry',
        lastError: message,
        retryDelay: Math.min(30000, 1000 * Math.pow(2, attempts - 1)),
        lastAttemptAt: now()
      });
    }

    function processMutation(item, results, state) {
      return store.updateMutation(item.operationId, { status: 'syncing' }).then(function () {
        return apiClient.call(item.action, item.payload, {
          operationId: item.operationId,
          baseUpdatedAt: item.baseUpdatedAt || ''
        });
      }).then(function (response) {
        if (response.ok) {
          return store.removeMutation(item.operationId).then(function () {
            results.push({ operationId: item.operationId, response: response });
          });
        }
        if (response.error && response.error.code === 'CONFLICT') {
          state.conflict = true;
          return store.updateMutation(item.operationId, {
            status: 'conflict',
            lastError: response.error.message || 'ข้อมูลชนกัน'
          }).then(function () {
            results.push({ operationId: item.operationId, response: response });
          });
        }
        return markRetry(item, response.error || new SyncError('API_ERROR', 'API mutation ไม่สำเร็จ'));
      }).catch(function (error) {
        return markRetry(item, error);
      });
    }

    function flush() {
      if (flushPromise) return flushPromise;
      if (!isOnline()) {
        notify('offline');
        return Promise.resolve([]);
      }
      var state = { conflict: false };
      flushPromise = store.listPendingMutations().then(function (items) {
        if (!items.length) {
          notify('online');
          return [];
        }
        notify('syncing', { count: items.length });
        var results = [];
        return items.reduce(function (chain, item) {
          return chain.then(function () {
            if (state.conflict) return undefined;
            return processMutation(item, results, state);
          });
        }, Promise.resolve()).then(function () {
          if (state.conflict) notify('conflict');
          else return store.listPendingMutations().then(function (remaining) {
            notify(remaining.length ? 'pending' : 'online', { count: remaining.length });
          });
          return results;
        }).then(function (result) { return result || results; });
      }).finally(function () { flushPromise = null; });
      return flushPromise;
    }

    function triggerFlush() {
      return flush().catch(function (error) {
        notify('error', { error: error });
        return [];
      });
    }
    if (global && typeof global.addEventListener === 'function') {
      global.addEventListener('online', triggerFlush);
    }
    if (global && global.document && typeof global.document.addEventListener === 'function') {
      global.document.addEventListener('visibilitychange', function () {
        if (global.document.visibilityState === 'visible') triggerFlush();
      });
    }

    return {
      loadSnapshot: loadSnapshot,
      queueMutation: queueMutation,
      flush: flush,
      getStatus: function () { return status; },
      subscribe: function (listener) {
        if (typeof listener !== 'function') return function () {};
        listeners.push(listener);
        return function () { listeners = listeners.filter(function (item) { return item !== listener; }); };
      }
    };
  }

  global.OrSyncError = SyncError;
  global.createOrSyncManager = createOrSyncManager;
}(typeof globalThis === 'undefined' ? this : globalThis));
