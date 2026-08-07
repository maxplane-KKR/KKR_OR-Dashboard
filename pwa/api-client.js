(function (global) {
  'use strict';

  function ApiError(code, message, details) {
    this.name = 'ApiError';
    this.code = code;
    this.message = message || code;
    this.details = details || {};
    if (Error.captureStackTrace) Error.captureStackTrace(this, ApiError);
  }
  ApiError.prototype = Object.create(Error.prototype);
  ApiError.prototype.constructor = ApiError;

  function hasGoogleRun(googleApi) {
    return Boolean(googleApi && googleApi.script && googleApi.script.run);
  }

  function parseResponse(response) {
    if (!response || typeof response.ok !== 'boolean') {
      throw new ApiError('RESPONSE_INVALID', 'API response is invalid');
    }
    return response;
  }

  function createOrApiClient(options) {
    var settings = options || {};
    var googleApi = settings.google || (typeof global.google === 'undefined' ? null : global.google);
    var fetchImpl = settings.fetchImpl || (typeof global.fetch === 'function' ? global.fetch.bind(global) : null);
    var apiBase = String(settings.apiBase || '/api').replace(/\/$/, '') || '/api';

    function callGoogle(action, payload) {
      return new Promise(function (resolve, reject) {
        if (!hasGoogleRun(googleApi)) {
          reject(new ApiError('API_UNAVAILABLE', 'ไม่พบช่องทางเชื่อมต่อ API'));
          return;
        }
        var runner = googleApi.script.run
          .withSuccessHandler(function (result) {
            try { resolve(parseResponse(result)); } catch (error) { reject(error); }
          })
          .withFailureHandler(function (error) {
            reject(new ApiError('SERVER_ERROR', error && error.message ? error.message : 'เรียก Apps Script ไม่สำเร็จ'));
          });
        if (payload === undefined) runner[action]();
        else runner[action](payload);
      });
    }

    function callStatic(action, payload, requestOptions) {
      if (typeof fetchImpl !== 'function') return Promise.reject(new ApiError('API_UNAVAILABLE', 'ไม่พบ fetch สำหรับ static API'));
      var mutation = requestOptions && requestOptions.operationId;
      var requestUrl = apiBase;
      var fetchOptions;
      if (mutation) {
        fetchOptions = {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: action,
            payload: payload || {},
            operationId: requestOptions.operationId,
            baseUpdatedAt: requestOptions.baseUpdatedAt || ''
          })
        };
      } else {
        requestUrl += (requestUrl.indexOf('?') >= 0 ? '&' : '?') + 'api=1&action=' + encodeURIComponent(action) +
          '&payload=' + encodeURIComponent(JSON.stringify(payload || {}));
      }
      return Promise.resolve().then(function () { return fetchImpl(requestUrl, fetchOptions); })
        .catch(function (error) {
          if (error && error.name === 'ApiError') throw error;
          throw new ApiError('NETWORK_ERROR', error && error.message ? error.message : 'เชื่อมต่อ API ไม่สำเร็จ');
        })
        .then(function (response) {
          if (!response || !response.ok) throw new ApiError('HTTP_ERROR', 'API ตอบกลับด้วยสถานะผิดพลาด', { status: response && response.status });
          return response.json();
        })
        .catch(function (error) {
          if (error && error.name === 'ApiError') throw error;
          throw new ApiError('RESPONSE_INVALID', error && error.message ? error.message : 'อ่าน API response ไม่สำเร็จ');
        })
        .then(parseResponse);
    }

    return {
      call: function (action, payload, requestOptions) {
        return hasGoogleRun(googleApi) && !(requestOptions && requestOptions.forceStatic)
          ? callGoogle(action, payload)
          : callStatic(action, payload, requestOptions);
      }
    };
  }

  global.OrApiError = ApiError;
  global.createOrApiClient = createOrApiClient;
}(typeof globalThis === 'undefined' ? this : globalThis));
