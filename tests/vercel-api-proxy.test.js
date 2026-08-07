'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createHandler } = require('../api/index.js');

function createResponse() {
  return {
    headers: {},
    statusCode: 200,
    body: '',
    setHeader(name, value) { this.headers[name.toLowerCase()] = String(value); },
    end(value) { this.body = value == null ? '' : String(value); },
  };
}

test('Vercel proxy forwards GET query to Apps Script and returns JSON unchanged', async () => {
  const requests = [];
  const handler = createHandler({
    env: { OR_APPS_SCRIPT_URL: 'https://script.google.com/macros/s/test/exec' },
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      return {
        status: 200,
        headers: { get: (name) => name.toLowerCase() === 'content-type' ? 'application/json; charset=utf-8' : null },
        text: async () => '{"ok":true,"data":{"items":[]},"error":null,"meta":{}}',
      };
    },
  });
  const response = createResponse();

  await handler({
    method: 'GET',
    url: '/api?api=1&action=getDatalistEntries&payload=%7B%7D',
    headers: {},
  }, response);

  assert.equal(response.statusCode, 200);
  assert.equal(JSON.parse(response.body).ok, true);
  assert.match(requests[0].url, /^https:\/\/script\.google\.com\/macros\/s\/test\/exec\?/);
  assert.match(requests[0].url, /action=getDatalistEntries/);
  assert.equal(requests[0].options.method, 'GET');
  assert.match(response.headers['cache-control'], /no-store/);
});

test('Vercel proxy forwards POST mutation body and keeps the upstream response status', async () => {
  const requests = [];
  const handler = createHandler({
    env: { OR_APPS_SCRIPT_URL: 'https://script.google.com/macros/s/test/exec' },
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      return {
        status: 200,
        headers: { get: () => 'application/json; charset=utf-8' },
        text: async () => '{"ok":true,"data":{"pending":false},"error":null,"meta":{}}',
      };
    },
  });
  const response = createResponse();
  const requestBody = {
    action: 'updateDatalistOption',
    payload: { type: 'diagnosis', oldValue: 'old', value: 'new' },
    operationId: '123e4567-e89b-42d3-a456-426614174099',
    baseUpdatedAt: '',
  };

  await handler({ method: 'POST', url: '/api', headers: {}, body: requestBody }, response);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(requests[0].options.body), requestBody);
  assert.equal(requests[0].options.method, 'POST');
  assert.equal(requests[0].options.headers['Content-Type'], 'application/json');
});

test('Vercel proxy fails clearly when configuration is missing or upstream is not JSON', async () => {
  const missingConfig = createHandler({ env: {}, fetchImpl: async () => { throw new Error('should not call'); } });
  const missingResponse = createResponse();
  await missingConfig({ method: 'GET', url: '/api?api=1', headers: {} }, missingResponse);
  assert.equal(missingResponse.statusCode, 500);
  assert.equal(JSON.parse(missingResponse.body).error.code, 'APPS_SCRIPT_URL_NOT_CONFIGURED');

  const htmlUpstream = createHandler({
    env: { OR_APPS_SCRIPT_URL: 'https://script.google.com/macros/s/test/exec' },
    fetchImpl: async () => ({
      status: 200,
      headers: { get: () => 'text/html; charset=utf-8' },
      text: async () => '<html>old Apps Script deployment</html>',
    }),
  });
  const htmlResponse = createResponse();
  await htmlUpstream({ method: 'GET', url: '/api?api=1', headers: {} }, htmlResponse);
  assert.equal(htmlResponse.statusCode, 502);
  assert.equal(JSON.parse(htmlResponse.body).error.code, 'UPSTREAM_NOT_JSON');
});
