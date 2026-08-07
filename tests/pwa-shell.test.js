'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');

function read(name) {
  return fs.readFileSync(path.join(root, name), 'utf8');
}

test('manifest มีชื่อ scope standalone และ icon ของ Dashboard/Admin', () => {
  const manifest = JSON.parse(read('manifest.webmanifest'));

  assert.equal(manifest.name, 'ORQ คิวห้องผ่าตัด');
  assert.equal(manifest.short_name, 'ORQ');
  assert.equal(manifest.start_url, '/Index.html');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.theme_color, '#062566');
  assert.deepEqual(manifest.icons[0], {
    src: 'Icon/orq-dashboard.png',
    sizes: '512x512',
    type: 'image/png',
    purpose: 'any maskable',
  });
  assert.equal(manifest.shortcuts[0].url, '/Admin.html?page=admin');
  assert.equal(manifest.shortcuts[0].icons[0].src, 'Icon/orq-admin.png');
});

test('PWA files และ artwork ที่ manifest อ้างถึงมีอยู่จริง', () => {
  ['sw.js', 'offline.html', 'pwa/runtime.js', 'Icon/orq-dashboard.png', 'Icon/orq-admin.png']
    .forEach((name) => assert.equal(fs.existsSync(path.join(root, name)), true, name));
});

test('HTML ทั้งสองหน้าผูก manifest และ runtime register', () => {
  for (const page of ['Index.html', 'Admin.html']) {
    const html = read(page);
    assert.match(html, /rel=["']manifest["'][^>]+href=["'](?:\/)?manifest\.webmanifest["']/i);
    assert.match(html, /pwa\/runtime\.js/i);
  }
});

test('service worker มี cache version, navigation fallback และไม่ cache API', () => {
  const source = read('sw.js');
  assert.match(source, /orq-pwa-v1/);
  assert.match(source, /offline\.html/);
  assert.match(source, /request\.url.*\/api|url\.pathname.*\/api/s);
  assert.match(source, /respondWith/);
});
