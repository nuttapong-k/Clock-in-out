# Clock In-Out: Cloudflare D1 + Google Sheets (v1)

## สถาปัตยกรรม
- Cloudflare Pages เสิร์ฟหน้าเว็บใน `public/`
- Cloudflare Worker ให้ API สำหรับ login, clock in/out, history, เพิ่มพนักงาน, รีเซ็ตรหัสผ่าน, CSV export และส่งรายงานไป Google Sheets
- Cloudflare D1 เป็นฐานข้อมูลหลักและแหล่งข้อมูลจริง (source of truth)
- Google Sheets เป็นสำเนารายงานที่ซิงก์จาก D1 ผ่าน Google Apps Script bridge
- การซิงก์เป็น upsert ด้วย `RecordID` ทำซ้ำช่วงวันที่เดิมได้โดยไม่เพิ่มแถวซ้ำ และไม่ลบข้อมูลใน D1

## ติดตั้ง Cloudflare
1. สร้าง D1 database ชื่อ `clockinout-prod` และจด database ID
2. คัดลอก `wrangler.toml.example` เป็น `wrangler.toml` แล้วใส่ ID จริง
3. รัน `npx wrangler d1 execute clockinout-prod --remote --file=./schema.sql`
4. สร้างบัญชี Admin ด้วย Node.js 20+: `node scripts/create-admin.mjs ADMIN001 "System Admin" "รหัสผ่านที่ยาวและไม่ซ้ำอย่างน้อย 12 ตัว"`
5. รัน `npx wrangler d1 execute clockinout-prod --remote --file=./seed-admin.sql` แล้วลบ `seed-admin.sql` อย่างปลอดภัย
6. ตั้งค่า secrets: `npx wrangler secret put GAS_WEB_APP_URL` และ `npx wrangler secret put GAS_SYNC_SECRET`
7. Deploy ผ่าน Wrangler/Cloudflare Pages ตามคู่มือ Cloudflare โดยให้ Worker ใช้ D1 binding `DB` และ assets binding `ASSETS`
8. ตั้ง `ALLOWED_ORIGIN` เป็นโดเมน Pages จริง ไม่ใช้ wildcard ใน production

## ตั้งค่า Google Sheets bridge
1. สร้าง Google Spreadsheet สำหรับรายงาน
2. เปิด Apps Script แล้วนำ `GoogleSheetsBridge.gs` ไปวาง
3. แก้ `SPREADSHEET_ID` ในไฟล์ให้เป็น ID ของชีต
4. ใน Apps Script > Project Settings > Script Properties เพิ่ม `D1_SYNC_SECRET` เป็น secret แบบสุ่มยาวอย่างน้อย 32 bytes
5. Deploy > New deployment > Web app; Execute as: Me; Who has access: Anyone (endpoint ป้องกันด้วย secret ใน body; ใช้ secret ยาวและเก็บเฉพาะใน Worker secret กับ Script Properties)
6. นำ URL ของ Web App ไปตั้งเป็น `GAS_WEB_APP_URL` ใน Worker และตั้ง `GAS_SYNC_SECRET` ให้ตรงกับ `D1_SYNC_SECRET`
7. Login ด้วยบัญชี Admin แล้วเลือกช่วงวันที่ไม่เกิน 31 วัน กด “ซิงก์ไป Google Sheets”

> Google Sheets เป็นรายงานปลายทาง ไม่ใช่ฐานข้อมูล login หรือฐานข้อมูลหลัก อย่าให้หน้าเว็บเขียนข้อมูลลงชีตโดยตรง

## รหัสผ่านและ session
- PBKDF2-HMAC-SHA-256, 310,000 iterations, random 16-byte salt, 256-bit derived key
- เก็บ algorithm/iterations ต่อบัญชีเพื่อรองรับการอัปเกรดค่ากำหนดในอนาคต
- รีเซ็ตรหัสผ่านสร้าง salt/hash ใหม่และเพิกถอน session ของบัญชีนั้น
- session token สุ่ม 256-bit; เก็บ SHA-256(token) ใน D1 ไม่เก็บ token จริง
- รหัสผ่านขั้นต่ำ 12 ตัวอักษรในขั้นตอนเพิ่ม/รีเซ็ตพนักงาน

## ข้อจำกัดที่ต้องทราบก่อน production
- เป็นฐานระบบ Cloudflare ใหม่ ไม่ใช่การแปลงทุกหน้าจอจาก Apps Script เดิมแบบ 1:1; tickets และการแก้ไขข้อมูลย้อนหลังยังไม่มี UI/API
- หนึ่ง record ต่อพนักงานต่อวัน (`UNIQUE employee_id, work_date`) ใช้วันตาม `Asia/Bangkok`; ถ้าพนักงาน clock in/out หลายกะในวันเดียว ต้องปรับ schema และ flow ก่อน
- sync สูงสุด 20,000 แถว/ครั้ง และช่วงวันที่ไม่เกิน 31 วัน
- ต้องทดสอบ Apps Script Web App response/redirect ในบัญชี Google องค์กรจริงก่อนเปิดใช้
- import ข้อมูลเดิมต้องทำ mapping และตรวจสอบก่อน; hash เดิมจาก Apps Script ไม่ได้ถูกนำมาใช้ตรง ๆ อัตโนมัติ ให้ตั้งรหัสผ่านใหม่หรือพัฒนา migration verifier ที่ตรวจสูตรเดิมก่อน
- ก่อน production ให้เพิ่ม rate limiting/WAF ที่ login, policy lockout, monitoring/alerts, backup D1 และทดสอบโหลดจริง

## API
- `POST /api/login`, `POST /api/logout`, `GET /api/me`
- `POST /api/clock/in`, `POST /api/clock/out`
- `GET /api/history?from=YYYY-MM-DD&to=YYYY-MM-DD`
- `GET/POST /api/admin/employees`, `POST /api/admin/password-reset`
- `POST /api/admin/sync-sheets` (สูงสุด 31 วัน)
- `GET /api/admin/export.csv?from=YYYY-MM-DD&to=YYYY-MM-DD`
