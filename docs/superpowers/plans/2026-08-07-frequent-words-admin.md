# หน้า “คำที่ใช้บ่อย” สำหรับ Admin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: ใช้ TDD และทำงานตามรายการ checkbox นี้ทีละงาน พร้อมตรวจผลก่อนเริ่มงานถัดไป

**Goal:** เพิ่มหน้า `คำที่ใช้บ่อย` ใน `Admin.html` พร้อม CRUD ระดับ row ของ `DatalistOptions` และ sync ค่าใน `Queues` โดยเพิ่มแท็บที่ 3 สำหรับ iPad/มือถือ

**Architecture:** เพิ่ม API Apps Script สำหรับอ่าน/สร้าง/แก้ไข/ลบรายการใน `DatalistOptions` ภายใต้ Script Lock และใช้ helper เดียวกันเพื่อแทนที่หรือล้างค่าที่เกี่ยวข้องใน `Queues` โดยไม่ลบ row คิว เพิ่ม panel ใหม่เต็มความกว้างใต้ workspace เดิมบน Desktop และให้ controller เดิมสลับ panel ที่ 3 ผ่าน bottom tab บน viewport แคบ

**Tech Stack:** Google Apps Script, Google Sheets, HTML/CSS/vanilla JavaScript, Node.js `node:test`, `vm`

## Global Constraints

- แก้เฉพาะ `Admin.html` และ `code.gs` ใน `For-Edit_Home`; ไม่แตะไฟล์ deploy/QA ที่อยู่นอก workspace
- ไม่เปลี่ยน schema `Queues` หรือ `DatalistOptions` และไม่เพิ่ม dependency
- ชื่อที่แสดงต่อผู้ใช้ต้องเป็น `คำที่ใช้บ่อย`
- รองรับ 6 type: `diagnosis`, `operation`, `surgeon`, `anesthetist`, `rights`, `surgeryType`
- แก้ไข/ลบใน `DatalistOptions` ต้องกระทบทั้ง row; `Queues` เปลี่ยนเฉพาะ field และห้ามลบ row คิว
- `surgeryType` ต้องแก้ไข/ลบสมาชิกใน JSON array โดยคงสมาชิกอื่นไว้
- ค่าใหม่ซ้ำ normalized key ใน type เดียวกันต้องถูกปฏิเสธ
- คงหน้าตา สี responsive pattern และฟังก์ชันเดิมของ Admin
- ทุก production function ใหม่ต้องมี failing test ก่อนเขียน implementation

---

### Task 1: Backend regression tests สำหรับ CRUD และการ sync

**Files:**
- Create: `tests/frequent-words-backend.test.js`
- Read: `code.gs`

**Interfaces:**
- Consumes: `loadGs`-style VM loader ที่อ่าน `..\code.gs` และ spreadsheet double ในไฟล์ test
- Produces: failing tests สำหรับ `createDatalistOption`, `getDatalistEntries`, `updateDatalistOption` และ `deleteDatalistOption`

- [ ] **Step 1: สร้าง spreadsheet double ที่รองรับ row CRUD**

สร้าง fake spreadsheet สำหรับชีต `Queues` และ `DatalistOptions` โดยรองรับ `getRange().getValues()`, `setValues()`, `deleteRow()`, `getLastRow()`, `getLastColumn()`, `insertSheet()` และอ่านค่าปัจจุบันผ่าน `values()` เพื่อ assert ทั้ง row

- [ ] **Step 2: เขียน failing test สำหรับการเพิ่มและโหลด row**

```js
test('createDatalistOption เพิ่ม row ใหม่และ getDatalistEntries คืนข้อมูล row ที่ปลอดภัย', () => {
  const { app, spreadsheet } = loadCurrentApp();
  const created = app.createDatalistOption({ type: 'operation', value: '  Phaco   + IOL  ' });
  assert.equal(created.ok, true);
  assert.equal(spreadsheet.sheet('DatalistOptions').values()[1][0], 'operation');
  assert.equal(spreadsheet.sheet('DatalistOptions').values()[1][1], 'Phaco + IOL');
  assert.equal(app.getDatalistEntries().data.items[0].normalizedKey, 'phaco + iol');
});
```

- [ ] **Step 3: เขียน failing test สำหรับ duplicate และ validation**

ทดสอบว่าเพิ่ม normalized key ซ้ำใน type เดิม, type ไม่รองรับ และ value ว่างคืน `{ ok: false }` โดยไม่เพิ่ม row ใหม่

- [ ] **Step 4: เขียน failing test สำหรับแก้ไข scalar และทั้ง row ใน DatalistOptions**

สร้าง queue 2 row ที่มี diagnosis เดิมและ option row 1 row จากนั้นเรียก `updateDatalistOption({ type: 'diagnosis', normalizedKey: 'cataract', value: 'ต้อกระจก' })` และ assert ว่า option row เดิมเปลี่ยนค่าโดยคง `type`/`createdAt`, queue ทั้ง 2 เปลี่ยน field, `affectedQueueRows` เป็น 2 และ cache ถูกล้าง

- [ ] **Step 5: เขียน failing test สำหรับลบ scalar และ surgeryType**

ทดสอบว่า `deleteDatalistOption` ลบทั้ง option row, ล้าง scalar ใน queue โดยไม่ลบ queue row และกรองค่าเดิมออกจาก `surgeryTypes` JSON array โดยเก็บสมาชิกอื่นไว้

- [ ] **Step 6: รัน test ให้ fail ด้วยเหตุผลว่า API ยังไม่มี**

Run: `node --test .\tests\frequent-words-backend.test.js`

Expected: FAIL จาก function API ที่ยังไม่ถูกประกาศ ไม่ใช่ syntax error ของ test double

---

### Task 2: Implement Apps Script datalist row CRUD และ queue sync

**Files:**
- Modify: `code.gs`
- Test: `tests/frequent-words-backend.test.js`

**Interfaces:**
- Consumes: `DATALIST_HEADERS`, `QUEUE_HEADERS`, `normalizeDatalistKey_`, `ensureSheet_`, `withScriptLock_`, `invalidateOrCache_`
- Produces:
  - `getDatalistEntries()` → `{ ok: true, data: { items: [{ type, value, normalizedKey, createdAt }] } }`
  - `createDatalistOption({ type, value })` → option row result plus affected counts
  - `updateDatalistOption({ type, normalizedKey, value })` → updated row result plus affected counts
  - `deleteDatalistOption({ type, normalizedKey })` → deleted row result plus affected counts

- [ ] **Step 1: เพิ่ม allowlist ของ type และตัวช่วย normalize request**

เพิ่ม mapping ของ 6 type ไปยัง field ใน `Queues`, พร้อม helper ที่ trim/collapse whitespace, ตรวจ type, ตรวจ value ที่ไม่ว่าง และใช้ `normalizeDatalistKey_` เป็น key กลาง

- [ ] **Step 2: เพิ่ม helper อ่านและ serialize DatalistOptions entries**

อ่านช่วงข้อมูลตั้งแต่ row 2, คืนเฉพาะ type ที่ allowlist, แปลง `value`/`normalizedKey`/`createdAt` เป็น string ที่ส่งไป client ได้ และไม่เปิดเผยข้อมูลนอก schema

- [ ] **Step 3: เพิ่ม helper sync ค่าใน Queues ตาม type**

อ่าน `Queues` ทั้งช่วงข้อมูลเป็น matrix แล้วแก้เฉพาะ column ที่ตรงกับ type: scalar ใช้ normalized old key เพื่อแทนที่/ล้างค่า; `surgeryType` parse array และแทนที่/กรองสมาชิก ใช้ `setValues` เขียนกลับเฉพาะเมื่อมี row เปลี่ยน พร้อมนับจำนวน row ที่เปลี่ยนและอัปเดต `updatedAt` ของ row ที่เปลี่ยน

- [ ] **Step 4: เพิ่ม `getDatalistEntries()` และ `createDatalistOption()`**

ให้ create ใช้ Script Lock, ตรวจ duplicate ก่อน append row `[type, value, normalizedKey, nowIso_()]`, ไม่แก้ `Queues`, และคืนผลลัพธ์แบบ `{ ok, data, error, meta }`

- [ ] **Step 5: เพิ่ม `updateDatalistOption()`**

ภายใต้ Script Lock ให้ค้น row ด้วย `type + normalizedKey`, ปฏิเสธค่าใหม่ที่ชน normalized key อื่น, เขียน `value`/`normalizedKey` ลง row เดิม, เรียก queue sync และล้าง cache เฉพาะเมื่อ queue เปลี่ยน

- [ ] **Step 6: เพิ่ม `deleteDatalistOption()`**

ภายใต้ Script Lock ให้ sync queue ก่อน/พร้อมกับการลบ row ที่ตรงกันจากล่างขึ้นบนด้วย `deleteRow`, คืนค่า row ที่ถูกลบและจำนวน queue ที่ล้าง โดยไม่เรียก `deleteRow` กับ `Queues`

- [ ] **Step 7: รัน backend tests ให้ green**

Run: `node --test .\tests\frequent-words-backend.test.js`

Expected: PASS ทุกกรณีของ create/read/update/delete, duplicate, scalar และ surgeryType sync

---

### Task 3: Admin controller failing tests สำหรับ panel และแท็บที่ 3

**Files:**
- Create: `tests/frequent-words-admin.test.js`
- Read: `Admin.html`

**Interfaces:**
- Consumes: script `or-admin-core` ที่ extract จาก `Admin.html`, fake document ที่รองรับ element lookup, children, events, focus และ dataset
- Produces: failing tests สำหรับ `loadFrequentWords`, `editFrequentWord`, `removeFrequentWord`, `handleFrequentWordsSubmit` และ `switchAdminMobilePanel('frequentWords')`

- [ ] **Step 1: สร้าง fake document เฉพาะ element ที่ controller ใหม่ใช้**

รองรับ `panelFrequentWords`, state elements, form elements, table body, card list และ `tabFrequentWords`; ให้ `querySelectorAll('[data-admin-tab]')` คืน tab เดิมและ tab ใหม่

- [ ] **Step 2: เขียน failing test ว่า initialization โหลด entries และ tab 3 สลับ panel**

```js
test('โหลดคำที่ใช้บ่อยและสลับ mobile ไปหน้าที่ 3', async () => {
  const harness = createHarness({
    getFrequentWords: () => Promise.resolve(successful({ items: [entry('operation', 'Phaco + IOL')] })),
  });
  await harness.controller.initialize();
  assert.equal(harness.calls.frequentWords.length, 1);
  harness.controller.switchAdminMobilePanel('frequentWords');
  assert.equal(harness.document.getElementById('panelFrequentWords').dataset.mobileActive, 'true');
  assert.equal(harness.document.getElementById('tabFrequentWords').getAttribute('aria-selected'), 'true');
});
```

- [ ] **Step 3: เขียน failing test สำหรับ add/edit/delete payload**

ทดสอบ add ส่ง `{ type, value }`, edit ส่ง `{ type, normalizedKey, value }`, delete ส่ง `{ type, normalizedKey }`, ปิด mutation เฉพาะ row, เรียก reload และ `loadFormOptions` หลังสำเร็จ

- [ ] **Step 4: เขียน failing test สำหรับ server error และยืนยันการลบ**

ทดสอบเมื่อ server คืน `{ ok: false }` จะคง row/form ไว้ แสดงข้อความ error และเมื่อ confirm เป็น false จะไม่เรียก delete API

- [ ] **Step 5: รัน test ให้ fail เพราะ DOM/controller ยังไม่มี**

Run: `node --test .\tests\frequent-words-admin.test.js`

Expected: FAIL จาก element/API/controller ที่ยังไม่มี ไม่ใช่ fake DOM syntax error

---

### Task 4: Implement Admin markup, responsive styling และ controller

**Files:**
- Modify: `Admin.html`
- Test: `tests/frequent-words-admin.test.js`

**Interfaces:**
- Consumes: `getDatalistEntries`, `createDatalistOption`, `updateDatalistOption`, `deleteDatalistOption`, `getDatalistOptions` และ primitives เดิมของ Admin
- Produces: panel `panelFrequentWords`, tab `tabFrequentWords`, and controller methods `loadFrequentWords`, `handleFrequentWordsSubmit`, `editFrequentWord`, `cancelFrequentWordEdit`, `removeFrequentWord`, `switchAdminMobilePanel`

- [ ] **Step 1: เพิ่ม failing static contract ก่อนแก้ markup**

เพิ่ม assertion ใน test ว่า HTML มีข้อความ `คำที่ใช้บ่อย`, `panelFrequentWords`, `tabFrequentWords`, `data-admin-tab="frequentWords"` และ option value ของทั้ง 6 type; รันให้ fail ก่อนแก้ไฟล์

- [ ] **Step 2: เพิ่ม CSS ของ panel รายการคำ**

ใช้ token เดิมของ `.panel`, `.field-control`, `.button`, `.list-state`, `.toast-region`; เพิ่ม grid/table/card rules ที่รองรับข้อความยาว, focus, disabled, error และ forced colors โดยไม่เพิ่ม shadow/radius system ใหม่

- [ ] **Step 3: เพิ่ม markup ของ panel และ tab 3**

วาง panel หลัง `.admin-workspace` บน Desktop, เพิ่มฟอร์มเพิ่มคำ, state, table body, mobile card list และเพิ่ม tab ที่ 3 ใน `.bottom-tabs` พร้อม `aria-controls`, `role="tab"`, `aria-selected`

- [ ] **Step 4: เพิ่ม dependencies และ state ใน `createAdminController`**

เพิ่ม default server runners และ state ของ entries/group filter/editing/mutation; คง dependency injection เดิมเพื่อให้ test เรียก controller โดยไม่ใช้ `google.script.run`

- [ ] **Step 5: เพิ่ม render/state helpers**

เพิ่ม label map สำหรับ 6 type, format created date, render table row/card เฉพาะกลุ่มที่เลือกด้วย `textContent`, `setFrequentWordsState`, `hideFrequentWordsState` และสร้าง inline edit controls ที่มี accessible names

- [ ] **Step 6: เพิ่ม CRUD handlers**

เพิ่ม load/add/edit/cancel/delete handlers; trim value ฝั่ง client, ปิดปุ่มระหว่าง mutation, ยืนยันก่อนลบ, แสดง affected counts, reload entries และเรียก `loadFormOptions()` หลัง create/update/delete สำเร็จ; ให้ toast auto-dismiss และยกเลิก timer เดิมเมื่อมีข้อความใหม่

- [ ] **Step 7: ขยาย `switchAdminMobilePanel()` และ event binding เป็น 3 panel**

ตั้ง `data-mobile-active` และ `aria-selected` ให้ panel/tab ทั้งสามทุกครั้ง, focus panel ที่เลือก, ให้ Desktop ไม่ค้าง hidden เมื่อขยายกลับ และให้ iPad/mobile panel ที่เลือกเต็มพื้นที่

- [ ] **Step 8: ให้ initialize โหลดหน้าคำโดยไม่บล็อกฟอร์มเดิม**

โหลด `loadFrequentWords()` ร่วมกับ form options และ queue list; หากโหลดคำล้มเหลวให้แสดง error เฉพาะ panel และยังใช้ฟอร์ม/รายการคิวได้

- [ ] **Step 9: รัน Admin tests ให้ green**

Run: `node --test .\tests\frequent-words-admin.test.js`

Expected: PASS static contract, tab 3, group filter, add/edit/delete, refresh datalist และ error recovery

---

### Task 5: Integration regression และ static safety checks

**Files:**
- Modify: `tests/frequent-words-backend.test.js` หากพบ regression assertion ที่ขาด
- Modify: `tests/frequent-words-admin.test.js` หากพบ DOM state ที่ยังไม่ครอบคลุม

**Interfaces:**
- Consumes: backend API และ Admin controller ที่ผ่าน unit-level tests แล้ว
- Produces: หลักฐานว่า data flow จาก mutation ไปยัง options และ UI ทำงานต่อเนื่อง

- [ ] **Step 1: เพิ่ม integration-style test สำหรับ mutation สำเร็จแล้ว refresh form datalist**

ให้ fake `getFrequentWords`, update/delete และ `getOptions` คืนค่าตามลำดับ แล้ว assert ว่า `diagnosisOptions`, `operationOptions`, `surgeryTypeOptions` ถูกสร้างใหม่หลัง mutation

- [ ] **Step 2: เพิ่ม test สำหรับ long labels และ untrusted text**

ใช้คำที่มี HTML-like text, Thai ยาว และ newline แล้ว assert ว่าแสดงผ่าน `textContent`, ไม่มี `innerHTML` สำหรับค่าจากชีต และ panel/card ไม่สร้าง action ที่ไม่มี accessible label

- [ ] **Step 3: ตรวจ syntax และ static contracts**

Run: `node --check .\tests\frequent-words-backend.test.js`

Run: `node --check .\tests\frequent-words-admin.test.js`

Run: `rg -n 'getDatalistEntries|createDatalistOption|updateDatalistOption|deleteDatalistOption|panelFrequentWords|tabFrequentWords|คำที่ใช้บ่อย' .\Admin.html .\code.gs`

Expected: ไม่มี syntax error และพบ API/DOM contract ครบ

---

### Task 6: Full verification และ handoff

**Files:**
- Read: `Admin.html`, `code.gs`, `tests/frequent-words-backend.test.js`, `tests/frequent-words-admin.test.js`

**Interfaces:**
- Consumes: tests และ source ที่แก้เสร็จ
- Produces: evidence ของ test result, diff, responsive behavior และข้อจำกัดที่ยังตรวจไม่ได้

- [ ] **Step 1: รัน test ใหม่ทั้งหมดใน workspace นี้**

Run: `node --test .\tests\frequent-words-backend.test.js .\tests\frequent-words-admin.test.js`

Expected: exit code 0 และไม่มี failed test

- [ ] **Step 2: รันชุดทดสอบเดิมจาก repo ถ้า Node และ path พร้อม**

Run: `node ..\tests\run-all-tests.mjs`

Expected: รายงานผลจริงตามไฟล์ deploy เดิม; หากชุดเดิมอ่าน `DEPLOY_REPLACE_3_FILES` แทน workspace ให้รายงานเป็นขอบเขตที่ยังไม่ได้ตรวจ ไม่แก้ไฟล์นอก workspace

- [ ] **Step 3: ตรวจ diff และ secret safety**

Run: `git diff --check -- .\Admin.html .\code.gs`

Run: `rg -n -i 'spreadsheetId|deployment token|access token|api[_-]?key|password|secret' .\Admin.html .\code.gs`

Expected: ไม่มี whitespace error และไม่มี secret ใหม่

- [ ] **Step 4: ตรวจ responsive และ interaction**

ตรวจที่ 1440px, 1024px และ 390px ว่า Desktop เห็น panel `คำที่ใช้บ่อย`, iPad/mobile มี bottom tab 3 ปุ่ม, panel ไม่ล้นแนวนอน, focus/confirm/error/success ทำงาน และ form datalist สะท้อนค่าหลัง mutation

- [ ] **Step 5: ตรวจสถานะ Git และสรุป handoff**

Run: `git status --short`

รายงานไฟล์ที่เปลี่ยน คำสั่งที่รัน ผลจริง และความเสี่ยงที่ยังต้องตรวจใน Google Apps Script/Google Sheets จริง โดยไม่อ้างว่า deploy หรือ production ผ่านหากยังไม่ได้ทำ
