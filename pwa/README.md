# OR Dashboard PWA

โฟลเดอร์นี้เป็น static PWA shell สำหรับหน้า Dashboard และ Admin โดยเก็บข้อมูลออฟไลน์ผ่าน IndexedDB ของเบราว์เซอร์ ไม่ต้องมี account, OAuth หรือ credential ของ IndexedDB

## ขอบเขต API proxy

PWA เรียก API ผ่าน origin เดียวกับเว็บเพื่อไม่ฝัง URL หรือ secret ของ Apps Script ในไฟล์หน้าเว็บ

- `GET /api?api=1&action=getQueues&payload=...` ใช้สำหรับอ่านข้อมูล
- `POST /api` ใช้สำหรับ mutation โดยส่ง `{ action, payload, operationId, baseUpdatedAt }`
- proxy ต้อง forward request ไปยัง Apps Script Web App `/exec` และส่ง status/body กลับตามเดิม
- ห้าม cache `POST` และห้ามบันทึก payload ที่อาจมีข้อมูลผู้ป่วยลง log
- ค่า URL ปลายทางและ credential ถ้ามี ต้องอยู่ใน environment ของ proxy ไม่อยู่ใน source หรือ manifest

## Offline behavior

- หน้าเว็บและ asset หลักใช้ service worker cache
- snapshot และ outbox ใช้ IndexedDB ชื่อ `orq-dashboard`
- การสร้าง/แก้ไข/ลบคิวและคำที่ใช้บ่อยจะเก็บ operation ไว้ก่อนเมื่อออฟไลน์
- เมื่อกลับมาออนไลน์ ระบบส่ง operation ตามลำดับและใช้ `operationId` กันการเขียนซ้ำ
- หาก storage ถูกปิดหรือล้าง ระบบจะแจ้งว่าไม่มีข้อมูล offline และให้ใช้งานเมื่อออนไลน์

## ก่อนใช้งานจริง

ต้องเลือก static host และสร้าง `/api` proxy ที่มี policy เรื่อง HTTPS, CORS, authentication และสิทธิ์เข้าถึง Google Sheet ให้เรียบร้อยก่อน production deploy ไฟล์ชุดนี้ยังไม่ deploy และไม่มี secret รวมอยู่
