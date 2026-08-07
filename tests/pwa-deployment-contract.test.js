'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('PWA static host keeps the API same-origin and out of the service-worker cache', () => {
  const manifest = JSON.parse(read('manifest.webmanifest'));
  const client = read(path.join('pwa', 'api-client.js'));
  const serviceWorker = read('sw.js');

  assert.equal(manifest.start_url, '/Index.html');
  assert.equal(manifest.scope, '/Index.html');
  assert.match(client, /apiBase \|\| '\/api'/);
  assert.match(client, /method: 'POST'/);
  assert.match(serviceWorker, /\/api/);
  assert.match(serviceWorker, /url\.origin !== self\.location\.origin/);
});

test('PWA deployment handoff documents the proxy boundary without credentials', () => {
  const guide = read(path.join('pwa', 'README.md'));

  assert.match(guide, /GET \/api/);
  assert.match(guide, /POST \/api/);
  assert.match(guide, /Apps Script Web App/);
  assert.match(guide, /secret|credential/i);
});
