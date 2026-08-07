# Design Spec: OR Dashboard PWA แบบ Offline-first

สถานะ: รอผู้ใช้ตรวจเอกสารออกแบบ
วันที่: 2026-08-07

## เป้าหมาย

ทำให้ OR Dashboard และหน้า Admin ติดตั้งเป็น PWA ได้บน desktop, iPad และมือถือ โดย:

- เปิดหน้าจอและเมนูหลักจาก cache ได้เมื่อไม่มีอินเทอร์เน็ต
- แสดงข้อมูลคิวล่าสุดที่เคยโหลดไว้ได้แบบ read-only เมื่อออฟไลน์
- รองรับเพิ่ม แก้ไข และลบข้อมูลแบบออฟไลน์ แล้วส่งเข้า Google Sheet เมื่อกลับมาออนไลน์
- รักษา Apps Script และ Google Sheet เป็นแหล่งข้อมูลหลักในระยะแรก
- แยก preview/QA ออกจากการ deploy production

## ไม่อยู่ในขอบเขตระยะแรก

- ยังไม่ย้ายข้อมูลจาก Google Sheet ไปฐานข้อมูลใหม่
- ยังไม่ฝัง credential หรือ secret ไว้ใน PWA
- ยังไม่เพิ่ม push notification หรือการ sync เบื้องหลังขณะที่แอปถูกปิด
- ยังไม่เปิดใช้ production จนกว่าจะทดสอบสิทธิ์และการ sync ครบ

## สภาพระบบปัจจุบัน

- `code.gs` ใช้ `doGet()` ส่ง `Index.html` หรือ `Admin.html` ผ่าน Apps Script `HtmlService`
- `Admin.html` และ `Index.html` เรียก server ด้วย `google.script.run`
- backend มี `getQueues`, `createQueue`, `updateQueue`, `deleteQueue`, `setQueueStatus`
- backend มี CRUD ของ `DatalistOptions` และ sync คำกลับไปยัง `Queues`
- ข้อมูลคิวมี UUID และ `updatedAt`; mutation ใช้ `LockService`
- ยังไม่มี `manifest.webmanifest`, service worker หรือชั้นเก็บข้อมูล IndexedDB
- `deleteQueue()` ตั้งค่า `deletedAt` แล้วลบแถวออกจากชีตจริง ทำให้ไม่มี tombstone สำหรับการ sync ออฟไลน์

Apps Script HTML Service ถูกครอบด้วย iframe sandbox และ API `google.script.run` เป็น client API เฉพาะบริบท HTML Service จึงไม่ควรใช้หน้า Apps Script เป็น PWA origin หลักโดยตรง ([HTML Service restrictions](https://developers.google.com/apps-script/guides/html/restrictions), [Client-to-server communication](https://developers.google.com/apps-script/guides/html/communication))

## แนวทางที่เลือก: Static PWA + API Proxy + Apps Script API

```text
PWA origin เดียว
  ├─ manifest.webmanifest
  ├─ service worker
  ├─ Cache Storage: HTML/CSS/JS/icon/offline shell
  └─ IndexedDB: snapshot + outbox + sync state
          │ same-origin API
          ▼
API Proxy / edge function
          │ HTTPS
          ▼
Apps Script Web App: doGet/doPost
          ▼
Google Sheet
```

PWA จะอยู่บน static hosting ที่รองรับ HTTPS เช่น GitHub Pages, Cloudflare Pages หรือ host ที่ผู้ใช้เลือกภายหลัง ส่วน Apps Script ทำหน้าที่เป็น API สำหรับอ่าน/เขียนข้อมูลด้วย `doGet` และ `doPost` ซึ่งสามารถตอบ JSON ผ่าน Content Service ได้ ([Apps Script Web Apps](https://developers.google.com/apps-script/guides/web?authuser=4), [Content Service](https://developers.google.com/apps-script/guides/content?authuser=2&hl=en))

ใช้ API Proxy เป็นค่าเริ่มต้นเพื่อให้ browser เรียก API จาก origin เดียวกับ PWA และไม่ผูก frontend กับข้อจำกัด cross-origin ของ Apps Script โดยตรง หากทดสอบ deployment จริงแล้วเรียก Apps Script โดยตรงได้อย่างปลอดภัย อาจลด proxy ในภายหลังได้

## โครงสร้าง PWA

### Routes และ assets

- `/` หรือ `/index.html`: Dashboard
- `/admin`: Admin
- `/manifest.webmanifest`: ชื่อแอป, สี, display standalone, start URL และไอคอน
- `/sw.js`: service worker scope ที่ root ของ PWA
- `/offline.html`: fallback เมื่อไม่มี snapshot หรือ API ใช้งานไม่ได้
- ใช้ `Icon/orq-dashboard.*` และ `Icon/orq-admin.*` เป็น artwork หลัก โดยตรวจขนาด PNG/ICO ก่อนผูก manifest

ไม่ใช้ `file://` เป็นเกณฑ์ทดสอบ installability; local QA ใช้ `localhost` และ production ใช้ HTTPS

### Cache policy

- App shell และ assets ที่มี version: cache-first พร้อม cache version ใหม่
- API อ่านข้อมูลคิว: network-first; ถ้า network ล้มเหลวใช้ snapshot ล่าสุดจาก IndexedDB
- API mutation: ไม่ cache response แบบทั่วไป แต่บันทึกคำสั่งลง outbox และใช้ response สำหรับยืนยันผล
- ลบ cache version เก่าหลัง service worker activate สำเร็จ

Service worker จะควบคุม request ใน scope ของ PWA ส่วน Cache Storage ใช้เก็บ asset และ IndexedDB ใช้เก็บข้อมูลโครงสร้าง/คิวรอส่ง ([Service workers](https://web.dev/learn/pwa/service-workers?hl=en), [Offline data](https://web.dev/learn/pwa/offline-data?hl=en))

### IndexedDB stores

- `snapshots`: dashboard/admin data ล่าสุด, timestamp และ server revision
- `outbox`: `operationId`, action, payload, base revision, status, retry count, last error
- `syncMeta`: client ID, last sync time, API version และ migration version

`IndexedDB` ไม่ใช่บริการภายนอกและไม่ต้องมี account, OAuth หรือ credential ใด ๆ ระบบจะสร้างพื้นที่เก็บข้อมูลใน browser แยกตามอุปกรณ์และ PWA origin ให้เอง หากผู้ใช้ล้างข้อมูลเว็บหรือ browser ปิดการใช้งาน storage แอปจะกลับไปโหมดออนไลน์ และจะไม่รับรองการเขียนข้อมูลขณะออฟไลน์จนกว่าจะเปิด storage อีกครั้ง

ข้อมูลในเครื่องเป็น cache ของผู้ใช้ ไม่ใช่ source of truth และต้องแสดงสถานะ `ออฟไลน์`, `รอส่ง`, `sync สำเร็จ` ให้เห็นชัดเจน

## API contract

ให้ `code.gs` รองรับโหมด API เพิ่มจากโหมด HTML เดิม โดยแยก dispatcher อย่างชัดเจน:

- `doGet(e)` เมื่อเป็น API: อ่าน `action` และ query parameters แล้วคืน JSON
- `doPost(e)`: อ่าน JSON body แล้ว dispatch mutation
- `doGet(e)` เมื่อไม่ใช่ API: คงพฤติกรรมเปิด Dashboard/Admin เดิม

รูปแบบ response กลาง:

```json
{
  "ok": true,
  "data": {},
  "error": null,
  "requestId": "...",
  "serverTime": "..."
}
```

mutation body ต้องมี `operationId` ที่ client สร้างเองเพื่อป้องกัน retry แล้วเขียนซ้ำ และต้องส่ง `baseUpdatedAt` หรือ `baseRevision` ไปด้วย

การ map action จะ reuse function เดิม เช่น `getQueues`, `createQueue`, `updateQueue`, `deleteQueue`, `getDatalistEntries`, `createDatalistOption`, `updateDatalistOption` และ `deleteDatalistOption` ไม่สร้าง business rule ชุดที่สองใน proxy

## Offline และ sync flow

### อ่านข้อมูล

1. เปิดแอปแล้ว render snapshot ล่าสุดทันทีถ้ามี
2. แสดงเวลาที่ข้อมูลถูก sync ล่าสุด
3. ถ้าออนไลน์ ให้ดึงข้อมูลใหม่แล้วแทนที่ snapshot
4. ถ้าออฟไลน์และไม่มี snapshot ให้แสดง offline state พร้อมคำแนะนำให้เชื่อมต่ออินเทอร์เน็ต

### เพิ่ม/แก้ไข/ลบ

1. ตรวจ validation ฝั่ง client
2. อัปเดต UI แบบ optimistic และบันทึกคำสั่งลง `outbox`
3. ถ้าออนไลน์ให้ flush ทันที; ถ้าออฟไลน์รอ event `online`, เปิดแอป หรือกด sync
4. ส่งทีละ mutation ตามลำดับ โดย retry แบบ exponential backoff
5. เมื่อ server ตอบสำเร็จ ให้ลบ outbox item และ refresh snapshot
6. เมื่อ server ตอบ conflict ให้คงข้อมูลไว้เป็น `ต้องตรวจสอบ` และไม่เขียนทับ server เงียบ ๆ

### Conflict และการลบ

- เพิ่ม `revision` ต่อ record หรือใช้ `updatedAt` อย่างมีข้อตกลงเดียวกันทั้ง client/server
- ถ้า base revision ไม่ตรง ให้ server คืน `CONFLICT` พร้อมข้อมูลปัจจุบัน
- เปลี่ยนการลบคิวจากลบแถวจริงเป็น soft delete/tombstone ที่มี `deletedAt` และเก็บไว้จนกว่าจะผ่าน retention ที่กำหนด
- การแก้ไข/ลบคำที่ใช้บ่อยต้อง sync ผลกระทบต่อ `Queues` กลับมาใน response เดียว เพื่อให้ snapshot ฝั่ง client ตรงกับชีต
- ยังไม่เลือก last-write-wins เพราะข้อมูลคิวเป็นข้อมูลปฏิบัติงานและไม่ควรถูกเขียนทับโดยไม่แจ้งผู้ใช้

## ความปลอดภัยและสิทธิ์

- ห้ามใส่ Spreadsheet ID, OAuth token หรือ secret ใน PWA
- ต้องกำหนดก่อน deploy ว่า web app ใช้ Google login ของผู้ใช้ หรือจำกัดผ่าน proxy/เครือข่ายองค์กร
- API mutation ต้องตรวจสิทธิ์ฝั่ง Apps Script ทุกครั้ง ไม่เชื่อ `role` จาก client
- log เฉพาะ `requestId`, action และผลลัพธ์ที่จำเป็น ไม่ log payload ที่อาจมีข้อมูลผู้ป่วย
- ทดสอบกรณีเปิด PWA จากเครื่องที่ไม่มีสิทธิ์ และกรณี token/session หมดอายุ

## แผนส่งมอบเป็นระยะ

1. **API foundation**: แยก dispatcher, เพิ่ม JSON contract, idempotency และ test ของ API โดยยังไม่เปลี่ยน UI
2. **PWA shell**: เพิ่ม manifest, service worker, offline page, route และผูก icon ที่เลือกไว้
3. **Read cache**: เพิ่ม IndexedDB snapshot, network-first read และ offline indicator
4. **Offline mutation**: เพิ่ม outbox, optimistic UI, retry และ sync status
5. **Data safety**: เพิ่ม revision/conflict response และ tombstone สำหรับการลบ
6. **QA/deploy gate**: ทดสอบ desktop/iPad/mobile, offline/online, retry, conflict, สิทธิ์ และค่อยเลือก static hosting สำหรับ production

## ไฟล์ที่คาดว่าจะเปลี่ยนเมื่อเริ่ม implementation

- `code.gs`: API dispatcher, JSON response, idempotency, revision/tombstone
- `Admin.html`: เปลี่ยน server adapter เป็น API client และเพิ่ม sync state
- `Index.html`: เปลี่ยน server adapter เป็น API client, snapshot และ offline state
- `manifest.webmanifest`, `sw.js`, `offline.html`: ไฟล์ PWA ใหม่
- `tests/`: API contract, outbox/sync, conflict และ service-worker behavior
- proxy/edge function: แยก deployment ตาม static hosting ที่เลือก

## ความเสี่ยงและสิ่งที่ต้องตัดสินใจก่อนลงมือ

- ต้องมี static hosting ที่รองรับ HTTPS และกำหนด production URL
- ต้องยืนยัน deployment URL และสิทธิ์ของ Apps Script Web App
- ต้องเลือกวิธี auth ให้เหมาะกับผู้ใช้จริงก่อนเปิด mutation API
- ต้องกำหนด retention ของ tombstone และผู้มีสิทธิ์แก้ conflict
- ต้องยืนยันว่า Google Sheet ยังรับปริมาณ sync และ lock contention ได้เพียงพอ

## เกณฑ์ยอมรับ

- ติดตั้ง PWA ได้จาก desktop และมือถือที่รองรับ
- เปิดแอปโดยไม่มี network แล้วเห็น shell และ snapshot ล่าสุด
- เพิ่ม/แก้ไข/ลบแบบออฟไลน์แล้วข้อมูลถูกส่งเข้า Sheet ครบครั้งเดียวเมื่อกลับออนไลน์
- retry ซ้ำไม่สร้าง row ซ้ำ
- conflict ไม่เขียนทับข้อมูล server เงียบ ๆ
- ลบคิวหรือคำที่ใช้บ่อยแล้ว sync ข้ามอุปกรณ์ได้ตาม policy
- ผ่าน regression เดิมของ Dashboard, Admin และ frequent words โดยไม่มี horizontal overflow บน mobile
