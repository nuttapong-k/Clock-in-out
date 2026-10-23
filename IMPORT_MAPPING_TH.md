# Mapping จาก Google Sheets เดิมไป D1

| แท็บเดิม | ตาราง D1 | หมายเหตุ |
|---|---|---|
| Employees | employees | ไม่ import Password เดิมเป็น plain text; สร้าง salt/hash ใหม่หรือทำ verifier migration อย่างปลอดภัย |
| Attendance | attendance | RecordID เป็น primary key; ตรวจรายการซ้ำ EmployeeID + WorkDate ก่อน import |
| Tickets | tickets | เก็บไว้รองรับการต่อยอด; UI/API ยังไม่มีใน v1 |
| AuditLog | audit_log | map AuditID/ActorID/Action/RecordID/Details/CreatedAt |

Export CSV จาก Google Sheets, ทำ backup, ตรวจ header/วันที่/รหัสพนักงานซ้ำ แล้ว import เข้า D1 ใน staging ก่อน production. อย่าลบข้อมูลต้นทางจนกว่าจะเทียบยอดและทดสอบสำเร็จ.
