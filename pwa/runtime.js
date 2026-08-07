(function (global) {
  'use strict';

  var hasAppsScript = Boolean(global.google && global.google.script && global.google.script.run);
  var registrationPromise = Promise.resolve(null);

  function loadScript(path) {
    return new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      script.src = path;
      script.onload = resolve;
      script.onerror = function () { reject(new Error('โหลด PWA runtime ไม่สำเร็จ: ' + path)); };
      document.head.appendChild(script);
    });
  }

  function register() {
    if (hasAppsScript || !global.navigator || !global.navigator.serviceWorker) return registrationPromise;
    registrationPromise = global.navigator.serviceWorker.register('sw.js', { scope: './' })
      .catch(function () { return null; });
    return registrationPromise;
  }

  var ready = hasAppsScript
    ? Promise.resolve(null)
    : loadScript('pwa/api-client.js')
      .then(function () { return loadScript('pwa/store.js'); })
      .then(function () { return loadScript('pwa/sync.js'); })
      .then(function () {
        global.OR_API_CLIENT = global.createOrApiClient({ apiBase: '/api' });
        global.OR_STORAGE = global.createOrStore({});
        global.OR_SYNC_MANAGER = global.createOrSyncManager({ store: global.OR_STORAGE, apiClient: global.OR_API_CLIENT });
        return register();
      })
      .catch(function (error) {
        global.OR_PWA_BOOT_ERROR = error;
        return null;
      });

  global.OR_PWA_RUNTIME = Object.freeze({
    isStatic: !hasAppsScript,
    register: function () { return ready.then(register); },
    ready: ready,
  });
  global.OR_PWA_READY = ready;
}(window));
