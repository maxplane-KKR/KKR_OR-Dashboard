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
  assert.equal(manifest.scope, '/Index.html');
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
  ['sw.js', 'offline.html', 'pwa/runtime.js', 'manifest.webmanifest', 'admin-manifest.webmanifest', 'Icon/orq-dashboard.png', 'Icon/orq-admin.png']
    .forEach((name) => assert.equal(fs.existsSync(path.join(root, name)), true, name));
});

test('HTML ทั้งสองหน้าผูก manifest และ runtime register', () => {
  const pageManifests = {
    'Index.html': 'manifest.webmanifest',
    'Admin.html': 'admin-manifest.webmanifest',
  };

  for (const [page, manifest] of Object.entries(pageManifests)) {
    const html = read(page);
    assert.match(html, new RegExp(`rel=["']manifest["'][^>]+href=["'](?:\\/)?${manifest.replace('.', '\\.') }["']`, 'i'));
    assert.match(html, /pwa\/runtime\.js/i);
    assert.match(html, /pwa\/runtime\.js\?v=4/i);
  }
});

test('Dashboard และ Admin เป็น PWA คนละ identity พร้อม icon และ start URL ของตัวเอง', () => {
  const dashboard = JSON.parse(read('manifest.webmanifest'));
  const admin = JSON.parse(read('admin-manifest.webmanifest'));

  assert.equal(dashboard.id, '/Index.html');
  assert.equal(dashboard.start_url, '/Index.html');
  assert.equal(dashboard.icons[0].src, 'Icon/orq-dashboard.png');
  assert.equal(admin.id, '/Admin.html');
  assert.equal(admin.start_url, '/Admin.html?page=admin');
  assert.equal(admin.icons[0].src, 'Icon/orq-admin.png');
  assert.notEqual(dashboard.id, admin.id);
});

test('Dashboard และ Admin ใช้ scope ไม่ทับกันเพื่อให้ติดตั้งหน้านั้นได้', () => {
  const dashboard = JSON.parse(read('manifest.webmanifest'));
  const admin = JSON.parse(read('admin-manifest.webmanifest'));

  assert.equal(dashboard.scope, '/Index.html');
  assert.equal(admin.scope, '/Admin.html');
  assert.notEqual(dashboard.scope, admin.scope);
});

test('runtime ลงทะเบียน service worker ตามหน้าปัจจุบันและไม่ค้าง root scope เดิม', () => {
  const runtime = read(path.join('pwa', 'runtime.js'));

  assert.match(runtime, /function getPageScope\s*\(/);
  assert.match(runtime, /Admin\.html/);
  assert.match(runtime, /Index\.html/);
  assert.match(runtime, /scope:\s*getPageScope\(\)/);
  assert.match(runtime, /getRegistrations\(\)/);
});

test('HTML แต่ละหน้าประกาศ icon สำหรับการสร้างทางลัดบน Android', () => {
  const pageIcons = {
    'Index.html': 'Icon/orq-dashboard.png',
    'Admin.html': 'Icon/orq-admin.png',
  };

  for (const [page, icon] of Object.entries(pageIcons)) {
    const html = read(page);
    assert.match(html, new RegExp(`rel=["']icon["'][^>]+href=["']${icon.replace('/', '\\/')}["']`, 'i'));
    assert.match(html, new RegExp(`rel=["']apple-touch-icon["'][^>]+href=["']${icon.replace('/', '\\/')}["']`, 'i'));
  }
});

test('manifest shortcut icon รองรับ Android maskable', () => {
  const manifest = JSON.parse(read('manifest.webmanifest'));
  assert.match(manifest.shortcuts[0].icons[0].purpose, /maskable/);
});

test('runtime cache-busts dynamically loaded PWA scripts', () => {
  const runtime = read(path.join('pwa', 'runtime.js'));
  assert.match(runtime, /PWA_ASSET_VERSION/);
  assert.match(runtime, /script\.src = path \+ '\?v=' \+ PWA_ASSET_VERSION/);
});

test('service worker มี cache version, navigation fallback และไม่ cache API', () => {
  const source = read('sw.js');
  assert.match(source, /orq-pwa-v5/);
  assert.match(source, /admin-manifest\.webmanifest/);
  assert.match(source, /offline\.html/);
  assert.match(source, /request\.url.*\/api|url\.pathname.*\/api/s);
  assert.match(source, /respondWith/);
});

test('Vercel routes the root and lowercase index URL to the dashboard shell', () => {
  const config = JSON.parse(read('vercel.json'));
  assert.deepEqual(config.rewrites, [
    { source: '/', destination: '/Index.html' },
    { source: '/index.html', destination: '/Index.html' },
  ]);
});
