'use strict';

var JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

function proxyError(code, message, details) {
  var error = new Error(message);
  error.code = code;
  error.details = details || {};
  return error;
}

function responseBody(ok, data, error, meta) {
  return {
    ok: ok === true,
    data: data == null ? null : data,
    error: error || null,
    meta: meta || {}
  };
}

function writeJson(response, statusCode, body) {
  response.statusCode = statusCode;
  response.setHeader('Content-Type', JSON_CONTENT_TYPE);
  response.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  response.end(JSON.stringify(body));
}

function setCorsHeaders(response, request) {
  var origin = request && request.headers ? request.headers.origin : '';
  if (origin) response.setHeader('Access-Control-Allow-Origin', origin);
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  response.setHeader('Vary', 'Origin');
}

function getAppsScriptUrl(env) {
  var rawUrl = String((env || {}).OR_APPS_SCRIPT_URL || '').trim();
  if (!rawUrl) {
    throw proxyError('APPS_SCRIPT_URL_NOT_CONFIGURED', 'Apps Script Web App URL is not configured');
  }

  var target;
  try {
    target = new URL(rawUrl);
  } catch (error) {
    throw proxyError('APPS_SCRIPT_URL_INVALID', 'Apps Script Web App URL is invalid');
  }
  if (target.protocol !== 'https:' || !/\/exec\/?$/.test(target.pathname)) {
    throw proxyError('APPS_SCRIPT_URL_INVALID', 'Apps Script Web App URL must be an HTTPS /exec URL');
  }
  target.hash = '';
  return target;
}

function copyQuery(request, target) {
  var requestUrl = new URL(request.url || '/', 'https://or-dashboard.local');
  requestUrl.searchParams.forEach(function (value, key) {
    target.searchParams.set(key, value);
  });
  return target;
}

function readRequestBody(request) {
  if (request.body !== undefined && request.body !== null) {
    if (typeof request.body === 'string') return Promise.resolve(request.body);
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(request.body)) return Promise.resolve(request.body.toString('utf8'));
    return Promise.resolve(JSON.stringify(request.body));
  }

  return new Promise(function (resolve, reject) {
    var chunks = [];
    request.on('data', function (chunk) { chunks.push(Buffer.from(chunk)); });
    request.on('end', function () { resolve(Buffer.concat(chunks).toString('utf8')); });
    request.on('error', reject);
  });
}

function createHandler(options) {
  var settings = options || {};
  var env = settings.env || (typeof process === 'undefined' ? {} : process.env);
  var fetchImpl = settings.fetchImpl || (typeof fetch === 'function' ? fetch : null);

  return async function handler(request, response) {
    setCorsHeaders(response, request);
    var method = String(request && request.method || 'GET').toUpperCase();

    if (method === 'OPTIONS') {
      response.statusCode = 204;
      response.setHeader('Cache-Control', 'no-store');
      response.end();
      return;
    }
    if (method !== 'GET' && method !== 'POST') {
      writeJson(response, 405, responseBody(false, null, {
        code: 'METHOD_NOT_ALLOWED',
        message: 'Only GET and POST are supported',
        details: {}
      }, {}));
      return;
    }
    if (typeof fetchImpl !== 'function') {
      writeJson(response, 500, responseBody(false, null, {
        code: 'FETCH_UNAVAILABLE',
        message: 'Server fetch is unavailable',
        details: {}
      }, {}));
      return;
    }

    var target;
    try {
      target = getAppsScriptUrl(env);
    } catch (error) {
      writeJson(response, 500, responseBody(false, null, {
        code: error.code || 'PROXY_CONFIGURATION_ERROR',
        message: error.message || 'Proxy configuration is invalid',
        details: error.details || {}
      }, {}));
      return;
    }

    var fetchOptions = {
      method: method,
      headers: { Accept: 'application/json' },
      redirect: 'follow'
    };
    if (method === 'GET') {
      target = copyQuery(request, target);
    } else {
      fetchOptions.headers['Content-Type'] = 'application/json';
      fetchOptions.body = await readRequestBody(request);
    }

    var upstream;
    try {
      upstream = await fetchImpl(target.toString(), fetchOptions);
    } catch (error) {
      writeJson(response, 502, responseBody(false, null, {
        code: 'UPSTREAM_UNAVAILABLE',
        message: 'เชื่อมต่อ Apps Script ไม่สำเร็จ',
        details: {}
      }, {}));
      return;
    }

    var rawBody = await upstream.text();
    var contentType = upstream.headers && typeof upstream.headers.get === 'function'
      ? String(upstream.headers.get('content-type') || '')
      : '';
    if (!/application\/json/i.test(contentType)) {
      writeJson(response, 502, responseBody(false, null, {
        code: 'UPSTREAM_NOT_JSON',
        message: 'Apps Script deployment ไม่ได้ตอบ JSON API',
        details: { upstreamStatus: upstream.status }
      }, {}));
      return;
    }
    try {
      JSON.parse(rawBody);
    } catch (error) {
      writeJson(response, 502, responseBody(false, null, {
        code: 'UPSTREAM_INVALID_JSON',
        message: 'Apps Script ส่ง JSON ที่อ่านไม่ได้',
        details: { upstreamStatus: upstream.status }
      }, {}));
      return;
    }

    response.statusCode = upstream.status;
    response.setHeader('Content-Type', contentType || JSON_CONTENT_TYPE);
    response.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    response.end(rawBody);
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
