# OR Dashboard PWA Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: ทำงานตามรายการ checkbox นี้ทีละงาน พร้อมใช้ TDD และตรวจผลก่อนเริ่มงานถัดไป

**Goal:** ทำให้ Dashboard และ Admin ติดตั้งเป็น PWA ได้ มี app shell/offline snapshot และคิว mutation ที่ sync เข้า Google Sheet เมื่อกลับมาออนไลน์ โดยคง Apps Script เป็น backend หลัก

**Architecture:** ให้ไฟล์ HTML ใน workspace ทำหน้าที่เป็น static PWA origin ที่มี manifest และ service worker ส่วน `code.gs` รองรับทั้ง HTML mode เดิมและ JSON API mode ผ่าน `doGet`/`doPost` แอปใช้ API client เดียวที่เลือก `google.script.run` เมื่ออยู่ใน Apps Script และเลือก same-origin `/api` เมื่ออยู่ใน static host; ข้อมูลอ่านเก็บใน IndexedDB และคำสั่งเขียนเก็บใน outbox จนกว่า server จะยืนยันผล

**Tech Stack:** Google Apps Script, Google Sheets, HTML/CSS/vanilla JavaScript, Web App Manifest, Service Worker, Cache Storage, IndexedDB, Node.js built-in `node:test`, `vm`

## Global Constraints

- แก้เฉพาะไฟล์ใน `For-Edit_Home`; ไม่แก้ไฟล์ deploy/QA ที่อยู่นอก workspace
- ไม่เพิ่ม npm dependency หรือ framework
- ห้ามใส่ Spreadsheet ID, OAuth token, API key, password หรือ secret ในไฟล์ PWA
- `code.gs` ต้องคง `doGet` HTML mode และ `google.script.run` fallback ให้ใช้งานเดิมได้
- Static PWA ใช้ API base เดียวคือ `/api`; production proxy ต้อง forward ไป Apps Script Web App URL โดยไม่ cache mutation
- การอ่าน offline ใช้ snapshot ล่าสุดแบบ read-only; mutation offline ต้องแสดงสถานะ `รอส่ง`
- mutation ทุกตัวต้องมี UUID `operationId`, retry ได้โดยไม่สร้างผลซ้ำ และตรวจ `baseUpdatedAt`/revision ก่อนเขียน
- `Queues` ใช้ soft delete ด้วย `deletedAt`; ห้ามลบ row คิวจริงระหว่างการ sync
- `DatalistOptions` คง schema เดิมในระยะแรก; การลบคำใช้ API idempotency และ full snapshot เพื่อให้ client อื่นเห็นผล
- ใช้ artwork เดิมจาก `Icon/orq-dashboard.png` และ `Icon/orq-admin.png`; ไม่สร้าง asset ใหม่ในแผนนี้
- ทุก production behavior ใหม่ต้องมี failing test ก่อน implementation และต้องรัน test ที่เกี่ยวข้องหลังแก้
- ไม่ deploy production ในรอบ implementation นี้; ทดสอบผ่าน `localhost` หรือ HTTPS เท่านั้น ไม่ใช้ `file://` เป็นเกณฑ์ PWA

---

### Task 1: วาง API contract และ test harness ฝั่ง Apps Script

**Files:**
- Create: `tests/pwa-api.test.js`
- Read: `code.gs`, `tests/frequent-words-backend.test.js`

**Interfaces:**
- Consumes: `loadCurrentApp()` pattern จาก `tests/frequent-words-backend.test.js`
- Produces: `createApiEvent({ action, payload, method, operationId })`, `ContentService` double และ test contract สำหรับ `doGet`/`doPost`

- [ ] **Step 1: สร้าง fake `ContentService` และ event factory**

เพิ่ม double ที่เก็บ `content`, `mimeType` และสร้าง event ให้มีรูปแบบเดียวกับ Apps Script:

```js
function apiEvent({ method = 'GET', action, payload = {}, operationId = '' } = {}) {
  const query = { api: '1', action, payload: JSON.stringify(payload) };
  return {
    parameter: query,
    postData: method === 'POST'
      ? { contents: JSON.stringify({ action, payload, operationId }) }
      : undefined,
  };
}
```

- [ ] **Step 2: เขียน failing test ของ response envelope**

ทดสอบ API สำเร็จต้องคืน JSON ที่ parse ได้และมี `ok`, `data`, `error`, `meta`, `requestId`, `serverTime`; API error ต้องคืน `ok: false` และ error code ที่ตรวจได้

- [ ] **Step 3: เขียน failing test ของ read และ mutation dispatch**

เรียก `doGet(apiEvent({ action: 'getQueues', payload: { scope: 'TODAY' } }))` แล้ว assert ว่า dispatch ไป `getQueues`; เรียก `doPost(apiEvent({ method: 'POST', action: 'createQueue', payload }))` แล้ว assert ว่า dispatch ไป mutation ที่ถูกต้อง

- [ ] **Step 4: เขียน failing test ว่า HTML mode เดิมไม่เปลี่ยน**

เรียก `doGet({ parameter: { page: 'admin' } })` โดยไม่ใส่ `api=1` แล้ว assert ว่าได้ `HtmlOutput` ไม่ใช่ JSON API output

- [ ] **Step 5: รัน test เพื่อยืนยัน failure**

Run: `node --test .\tests\pwa-api.test.js`

Expected: FAIL เพราะ `doPost`, API dispatcher และ response helper ยังไม่มี โดย test harness ต้องไม่มี syntax error

---

### Task 2: เพิ่ม Apps Script JSON API, idempotency และ soft delete

**Files:**
- Modify: `code.gs`
- Test: `tests/pwa-api.test.js`, `tests/frequent-words-backend.test.js`

**Interfaces:**
- Consumes: `ok_`, `fail_`, `getQueues`, `createQueue`, `updateQueue`, `deleteQueue`, `setQueueStatus`, CRUD `DatalistOptions`
- Produces:
  - `doGet(e)` API mode → JSON `TextOutput`
  - `doPost(e)` → JSON `TextOutput`
  - `apiDispatch_(action, payload)` → existing `{ ok, data, error, meta }`
  - `withOperationId_(operationId, action, work)` → cached result หรือผล mutation ใหม่

- [ ] **Step 1: เพิ่ม constants และ fake sheet สำหรับ operation log**

เพิ่ม `SYNC_SHEET_NAME = 'SyncOperations'` และ `SYNC_HEADERS = ['operationId', 'action', 'resultJson', 'createdAt']`; ให้ `setupOrSpreadsheet()` เรียก `ensureSheet_` เพิ่ม และขยาย spreadsheet double ใน test ให้สร้างชีตนี้

- [ ] **Step 2: เขียน failing test ของ API action allowlist**

อนุญาตเฉพาะ `getQueues`, `getDatalistOptions`, `getDatalistEntries`, `createQueue`, `updateQueue`, `deleteQueue`, `setQueueStatus`, `createDatalistOption`, `updateDatalistOption`, `deleteDatalistOption`, `exportQueues`; action อื่นต้องคืน `API_ACTION_NOT_ALLOWED` และห้ามเรียก global function แบบ dynamic โดยไม่ตรวจ allowlist

- [ ] **Step 3: เขียน failing test ของ operation idempotency**

เรียก `doPost` ด้วย `operationId` เดิมสองครั้งและ fake mutation counter; assert ว่า mutation ทำงานครั้งเดียวและ response ครั้งที่สองเท่ากับครั้งแรก

- [ ] **Step 4: เพิ่ม JSON parser และ response helper**

เพิ่ม helper ตาม contract นี้:

```js
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
```

`apiRequest_` ต้อง parse `e.parameter.payload` สำหรับ GET และ `e.postData.contents` สำหรับ POST; JSON ผิดรูปต้องคืน `API_REQUEST_INVALID` โดยไม่เรียก Sheet

- [ ] **Step 5: เพิ่ม `apiDispatch_` และคง HTML `doGet`**

ใช้ object allowlist ที่ map action ไป function reference โดยตรง จากนั้นให้ `doGet(e)` ตรวจ `e.parameter.api === '1'`; ถ้าเป็น API ให้คืน `apiJson_`, ถ้าไม่ใช่ให้คง template `Index`/`Admin` และ title เดิม

- [ ] **Step 6: เพิ่ม `doPost(e)` และ operation log**

อ่าน `operationId` ที่เป็น UUID, ใช้ `withScriptLock_` อ่าน `SyncOperations`, ถ้ามี operation เดิมให้คืน `resultJson`, ถ้าไม่มีให้เรียก mutation แล้วบันทึก `{ operationId, action, resultJson, createdAt }` ก่อนคืน response; operation ที่ไม่มี UUID ต้องคืน `API_OPERATION_ID_REQUIRED`

- [ ] **Step 7: เปลี่ยน `deleteQueue()` เป็น soft delete**

คง `findActiveQueueRow_` เป็นตัวค้นหา active row แต่เปลี่ยนส่วน mutation จาก `sheet.deleteRow(existing.rowNumber)` เป็น `writeQueueRow_` พร้อม `deletedAt: now` และ `updatedAt: now`; `queryQueueRows_` กรอง `deletedAt` ต่อไปเหมือนเดิม และผล response ต้องคืน queue ที่มี `deletedAt`

- [ ] **Step 8: เพิ่ม test ของ soft delete และ API error**

assert ว่า row ใน `Queues` ยังอยู่หลัง delete, `getQueues` ไม่คืน row นั้น, delete retry ด้วย operation เดิมไม่เปลี่ยน row ซ้ำ และ error จาก validation ถูกห่อใน response envelope

- [ ] **Step 9: รัน backend/API tests ให้ green**

Run: `node --test .\tests\pwa-api.test.js .\tests\frequent-words-backend.test.js`

Expected: PASS API dispatch, HTML fallback, idempotency, soft delete และ CRUD frequent words เดิม

---

### Task 3: สร้าง PWA shell, manifest และ service worker

**Files:**
- Create: `manifest.webmanifest`
- Create: `sw.js`
- Create: `offline.html`
- Create: `pwa/runtime.js`
- Modify: `Admin.html`, `Index.html`
- Create: `tests/pwa-shell.test.js`

**Interfaces:**
- Consumes: `Icon/orq-dashboard.png`, `Icon/orq-admin.png`, static root paths
- Produces: `window.OR_PWA_RUNTIME.register()`, manifest ที่ติดตั้งได้ และ service worker cache version `orq-pwa-v1`

- [ ] **Step 1: เขียน failing static contract test**

ตรวจว่าไฟล์ manifest/service worker/offline มีอยู่, manifest มี `name`, `short_name`, `start_url`, `scope`, `display: 'standalone'`, icon dashboard และ shortcut Admin; HTML ทั้งสองมี manifest link และเรียก runtime register

- [ ] **Step 2: เพิ่ม manifest จริง**

ใช้ค่า:

```json
{
  "name": "ORQ คิวห้องผ่าตัด",
  "short_name": "ORQ",
  "start_url": "/Index.html",
  "scope": "/",
  "display": "standalone",
  "background_color": "#f4f8fd",
  "theme_color": "#062566",
  "icons": [{ "src": "Icon/orq-dashboard.png", "sizes": "512x512", "type": "image/png", "purpose": "any maskable" }],
  "shortcuts": [{ "name": "จัดการคิว", "url": "/Admin.html?page=admin", "icons": [{ "src": "Icon/orq-admin.png", "sizes": "512x512", "type": "image/png" }] }]
}
```

- [ ] **Step 3: เพิ่ม service worker แบบ network-first navigation**

ให้ `sw.js` precache `Index.html`, `Admin.html`, `manifest.webmanifest`, `offline.html`, `pwa/runtime.js` และ icon PNG; navigation ใช้ network-first แล้ว fallback cache/offline, same-origin static asset ใช้ cache-first, request ที่ path `/api` ห้ามเขียนลง cache และ request cross-origin ให้ผ่านไปตามปกติ

- [ ] **Step 4: เพิ่ม runtime register ที่ไม่ทำให้ Apps Script mode พัง**

สร้าง `pwa/runtime.js` ให้ตรวจ `navigator.serviceWorker`, เรียก `navigator.serviceWorker.register('/sw.js', { scope: '/' })` เฉพาะ static mode และกลืนเฉพาะ registration error; ห้ามทำให้ `google.script.run` เดิมหยุดทำงานเมื่อ Apps Script ไม่มี `sw.js`

- [ ] **Step 5: ผูก manifest/runtime กับ `Admin.html` และ `Index.html`**

เพิ่ม `<link rel="manifest" href="/manifest.webmanifest">`, theme color และ script runtime ใน head; เพิ่ม fallback path แบบ relative สำหรับ local server และให้ document ที่เปิดจาก Apps Script ยังโหลดต่อได้แม้ asset PWA ไม่พบ

- [ ] **Step 6: รัน shell tests ให้ green**

Run: `node --test .\tests\pwa-shell.test.js`

Expected: PASS manifest JSON, asset paths, service worker static contract และ HTML integration

---

### Task 4: สร้าง API client ที่รองรับ Apps Script และ static PWA

**Files:**
- Create: `pwa/api-client.js`
- Modify: `Admin.html`, `Index.html`
- Create: `tests/pwa-api-client.test.js`

**Interfaces:**
- Produces: `createOrApiClient({ fetchImpl, google, apiBase, now })`
- Client method: `call(action, payload, options)` → `Promise<{ ok, data, error, meta }>`
- Consumes: `window.OR_PWA_CONFIG.apiBase || '/api'`

- [ ] **Step 1: เขียน failing client tests**

ทดสอบ static read สร้าง GET `api=1`, `action`, `payload`; static mutationสร้าง POST JSON ที่มี `operationId`; response HTTP error และ JSON error ถูกแปลงเป็น `{ ok: false }`; Google mode เรียก `google.script.run.withSuccessHandler().withFailureHandler()` แทน fetch

- [ ] **Step 2: เพิ่ม `createOrApiClient` ด้วย dependency injection**

ใช้ signature นี้และไม่เรียก global `fetch`/`google` ตรงใน core:

```js
function createOrApiClient(options) {
  var fetchImpl = options.fetchImpl;
  var googleApi = options.google;
  var apiBase = options.apiBase || '/api';
  return { call: function (action, payload, requestOptions) { /* Promise */ } };
}
```

GET ส่ง payload เป็น `encodeURIComponent(JSON.stringify(payload || {}))`; POST ส่ง `{ action, payload, operationId, baseUpdatedAt }`; ทุก response ต้องตรวจ `body.ok` ก่อนคืนหรือ throw `ApiError` ที่มี `code`/`details`

- [ ] **Step 3: เปลี่ยน `Admin.html` server adapter**

ให้ `runServerFunction(name, payload)` ใช้ `window.OR_API_CLIENT.call(name, payload)` เมื่อ static client พร้อม; ถ้าไม่พร้อมและมี `google.script.run` ให้ใช้ runner เดิม; ถ้าไม่มีทั้งสองให้ reject ด้วย `API_UNAVAILABLE` แทนการสร้าง demo data สำหรับ mutation

- [ ] **Step 4: เปลี่ยน `Index.html` `loadPage()`**

ให้ static mode เรียก API client และคืน snapshot ผ่าน sync layer ใน Task 5; Apps Script mode เรียก `getQueues` ด้วย `google.script.run` แบบเดิม; ไม่ hardcode deployment URL ใน HTML

- [ ] **Step 5: รัน client tests ให้ green**

Run: `node --test .\tests\pwa-api-client.test.js`

Expected: PASS Google fallback, static GET/POST, malformed response และ network error mapping

---

### Task 5: เพิ่ม IndexedDB store และ offline snapshot

**Files:**
- Create: `pwa/store.js`
- Create: `tests/pwa-store.test.js`
- Modify: `pwa/runtime.js`

**Interfaces:**
- Produces: `createOrStore({ indexedDB, dbName, now })`
- Methods: `getSnapshot(key)`, `putSnapshot(key, value)`, `enqueueMutation(item)`, `listPendingMutations()`, `removeMutation(operationId)`, `updateMutation(operationId, patch)`, `getMeta(key)`, `putMeta(key, value)`
- Stores: `snapshots` keyPath `key`, `outbox` keyPath `operationId`, `meta` keyPath `key`

- [ ] **Step 1: เขียน failing tests ด้วย in-memory IndexedDB double**

ทดสอบ snapshot ถูกเขียน/อ่านตาม key, outbox เรียงตาม `createdAt`, update retry ไม่สร้าง item ใหม่ และ remove operation ไม่กระทบ snapshot อื่น

- [ ] **Step 2: เพิ่ม database migration version 1**

เปิด database ชื่อ `orq-dashboard`, สร้าง object stores ตาม schema และ reject ด้วย `STORAGE_UNAVAILABLE` เมื่อ `indexedDB` ไม่มีหรือเปิดฐานข้อมูลไม่ได้; ไม่เรียก login/account flow ใด ๆ

- [ ] **Step 3: เพิ่ม snapshot serialization**

เก็บ `{ key, value, savedAt, serverTime, revision }` โดย `key` ใช้ `dashboard:today` และ `admin:frequentWords`; ค่า payload ต้องเป็น plain JSON ที่ clone ได้

- [ ] **Step 4: เพิ่ม outbox serialization**

เก็บ `{ operationId, action, payload, baseUpdatedAt, createdAt, attempts, status, lastError }`; operationId ต้องเป็น UUID และห้ามเขียน item ซ้ำเมื่อ key เดิมถูก enqueue อีกครั้ง

- [ ] **Step 5: รัน store tests ให้ green**

Run: `node --test .\tests\pwa-store.test.js`

Expected: PASS snapshot, outbox ordering, retry update, duplicate operation และ storage error

---

### Task 6: เพิ่ม sync manager, retry และ conflict state

**Files:**
- Create: `pwa/sync.js`
- Create: `tests/pwa-sync.test.js`
- Modify: `Admin.html`, `Index.html`

**Interfaces:**
- Produces: `createOrSyncManager({ store, apiClient, online, now, random })`
- Methods: `loadSnapshot(key, loader)`, `queueMutation(action, payload, baseUpdatedAt)`, `flush()`, `getStatus()`, `subscribe(listener)`
- Status values: `online`, `offline`, `syncing`, `pending`, `conflict`, `error`

- [ ] **Step 1: เขียน failing tests ของ offline read**

เมื่อ `online()` เป็น false ให้ `loadSnapshot` คืน snapshot พร้อม `meta.cached: true`; เมื่อไม่มี snapshot ให้คืน `OFFLINE_NO_SNAPSHOT`; เมื่อออนไลน์ให้เรียก loader แล้วแทนที่ snapshot

- [ ] **Step 2: เขียน failing tests ของ offline mutation**

`queueMutation` ต้องสร้าง UUID, บันทึก outbox, คืน `{ ok: true, meta: { pending: true, offline: true } }` และไม่เรียก API ตอน offline; เมื่อ online ให้ `flush()` เรียก API ตาม `createdAt`

- [ ] **Step 3: เขียน failing tests ของ retry/conflict**

network error ต้องเพิ่ม `attempts`, เก็บ `lastError` และคง outbox; response error code `CONFLICT` ต้องเปลี่ยน status เป็น `conflict` และไม่ retry อัตโนมัติ; response สำเร็จต้องลบ outbox และเขียน snapshot ใหม่

- [ ] **Step 4: เพิ่ม sync manager แบบ single-flight**

ใช้ promise lock เดียวกันเพื่อไม่ให้ `flush()` ซ้อนกัน, retry delay เป็น `Math.min(30000, 1000 * 2 ** attempts)`, เรียก flush เมื่อ `window.online`, `visibilitychange` กลับมา visible และเปิดแอปใหม่

- [ ] **Step 5: เพิ่ม UI status hooks**

ให้ `Admin.html` แสดง toast/status สำหรับ `รอส่ง`, `กำลัง sync`, `sync สำเร็จ`, `ต้องตรวจสอบข้อมูลชนกัน`; ให้ `Index.html` แสดง timestamp ของ snapshot และป้าย offline โดยไม่บล็อกการอ่านข้อมูลที่ cache ไว้

- [ ] **Step 6: รัน sync tests ให้ green**

Run: `node --test .\tests\pwa-sync.test.js`

Expected: PASS offline read, optimistic mutation, ordered flush, exponential retry, conflict stop และ status notification

---

### Task 7: เชื่อม CRUD จริงของ Dashboard/Admin เข้ากับ sync layer

**Files:**
- Modify: `Admin.html`, `Index.html`
- Modify: `tests/frequent-words-admin.test.js`
- Create: `tests/pwa-ui.test.js`

**Interfaces:**
- Consumes: `createOrApiClient`, `createOrStore`, `createOrSyncManager`
- Produces: behavior เดิมของ form/table และ behavior ใหม่เมื่อ offline

- [ ] **Step 1: เพิ่ม failing UI tests ของ queue mutation offline**

ใช้ fake sync manager แล้ว assert ว่า submit queue, delete queue, set checked และ CRUD คำที่ใช้บ่อยเรียก `queueMutation()` เมื่อ offline; success toast ต้องเปลี่ยนเป็น pending toast และไม่ล้าง form ก่อน server acknowledgment

- [ ] **Step 2: เชื่อม `Admin.html` queue handlers**

เปลี่ยน `createQueue`, `updateQueue`, `deleteQueue`, `setQueueStatus`, frequent-word CRUD ให้ผ่าน server adapter/sync manager เดียว; กรณี `meta.pending` ให้คง optimistic UI และแสดงรายการรอส่ง; กรณี `CONFLICT` ให้ reload snapshot และเปิดข้อความให้ผู้ใช้ตรวจสอบ

- [ ] **Step 3: เชื่อม `Index.html` read path**

ให้ `loadAll()` ใช้ `loadSnapshot('dashboard:today', networkLoader)` และรวม cursor ทุกหน้าไว้ใน snapshot เดียว; เมื่อ offline render snapshot เดิมและไม่แสดง demo data ที่อาจทำให้ผู้ใช้เข้าใจว่าเป็นข้อมูลจริง

- [ ] **Step 4: เพิ่ม pending/conflict rendering ใน Admin**

แถวที่มี `operationId` pending ต้องมี `data-sync-state="pending"`, ปุ่ม mutation เดิมต้องไม่ส่งซ้ำ และ conflict ต้องมีปุ่ม reload/ยกเลิกคำสั่งที่มี accessible name

- [ ] **Step 5: รักษา mobile tab 3 และ frequent words behavior เดิม**

รัน regression ของ group filter, add/edit/delete, toast timer และ tab `คำที่ใช้บ่อย`; ห้ามเปลี่ยนชื่อหน้า/ลบ panel เดิม

- [ ] **Step 6: รัน UI tests ให้ green**

Run: `node --test .\tests\pwa-ui.test.js .\tests\frequent-words-admin.test.js`

Expected: PASS normal online mode, offline queue, pending state, conflict state และ regression หน้า Admin เดิม

---

### Task 8: ทดสอบ static host contract และ production handoff โดยยังไม่ deploy

**Files:**
- Create: `pwa/README.md`
- Create: `tests/pwa-deployment-contract.test.js`
- Read: `manifest.webmanifest`, `sw.js`, `code.gs`

**Interfaces:**
- Produces: contract สำหรับ same-origin `/api` proxy และ checklist deploy ที่ไม่ต้องฝัง secret

- [ ] **Step 1: เขียน deployment contract test**

assert ว่า PWA client ใช้ `/api` เป็น default, mutation ใช้ POST, API path ไม่ถูก service worker cache และ manifest start URL/scope อยู่ origin เดียวกัน

- [ ] **Step 2: เขียน `pwa/README.md` เป็นคำสั่ง proxy ที่ตรวจสอบได้**

ระบุว่า proxy ต้องรับ `GET /api?api=1&action=...&payload=...` และ `POST /api` แล้ว forward ไป Apps Script Web App `/exec`, ส่ง status/body กลับตามเดิม, ปิด cache สำหรับ POST และไม่เก็บ request payload ที่อาจมีข้อมูลผู้ป่วย; URL ปลายทางส่งผ่าน environment ของ host ไม่เขียนลง source

- [ ] **Step 3: รัน static/deployment tests**

Run: `node --test .\tests\pwa-shell.test.js .\tests\pwa-api-client.test.js .\tests\pwa-deployment-contract.test.js`

Expected: PASS โดยไม่ต้องมี account ของ IndexedDB และไม่ต้องมี secret ใน workspace

- [ ] **Step 4: ทดสอบ local HTTP behavior**

เปิด workspace ผ่าน HTTP server ที่ `http://127.0.0.1:8765`, ตรวจ Network ว่า `manifest.webmanifest`, `sw.js`, `offline.html`, icons และ `/api` ถูก resolve จาก origin เดียวกัน; ตรวจ Application panel ว่ามี service worker และ IndexedDB database `orq-dashboard`

- [ ] **Step 5: ทดสอบ offline/online matrix**

ตรวจอย่างน้อย 1440px desktop, 1024px iPad และ 390px mobile ในกรณี online load, offline reload, offline create/update/delete, reconnect retry, duplicate retry, conflict และ storage ถูกล้าง; เก็บผลไว้ใน `qa/` เฉพาะเมื่อผู้ใช้อนุมัติให้แก้ไฟล์ QA

---

### Task 9: Full verification และ handoff

**Files:**
- Read: source/test filesทั้งหมดในแผน

- [ ] **Step 1: รัน test suite ใน workspace**

Run: `node --test .\tests\pwa-api.test.js .\tests\pwa-api-client.test.js .\tests\pwa-shell.test.js .\tests\pwa-store.test.js .\tests\pwa-sync.test.js .\tests\pwa-ui.test.js .\tests\frequent-words-backend.test.js .\tests\frequent-words-admin.test.js .\tests\icon-design-preview.test.js`

Expected: exit code 0 และไม่มี failed test

- [ ] **Step 2: ตรวจ syntax และ whitespace**

Run: `node --check .\tests\pwa-api.test.js`

Run: `node --check .\tests\pwa-api-client.test.js`

Run: `git diff --check -- .\For-Edit_Home`

Expected: ไม่มี syntax error หรือ whitespace error ในไฟล์ที่แก้

- [ ] **Step 3: ตรวจ secret safety**

Run: `rg -n -i "spreadsheetId|access token|api[_-]?key|password|secret|oauth" .\Admin.html .\Index.html .\code.gs .\pwa .\manifest.webmanifest

Expected: ไม่พบ credential ใหม่; ค่า `/api` และชื่อ action เท่านั้นที่ปรากฏได้

- [ ] **Step 4: ตรวจการแยก local preview/production**

ยืนยันว่าไม่มีคำสั่ง deploy, publish, force push หรือแก้ไฟล์นอก `For-Edit_Home`; รายงาน API URL/auth/hosting ที่ยังต้องกำหนดก่อน production แยกจากผล local QA

- [ ] **Step 5: สรุป handoff**

รายงานไฟล์ที่เปลี่ยน, คำสั่งที่รันและผลจริง, พฤติกรรม offline ที่ตรวจแล้ว, ความเสี่ยงของ Apps Script Web App/สิทธิ์/Google Sheet lock และขั้นตอนถัดไปสำหรับเลือก static host กับ proxy
