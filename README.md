# แผนผังตำแหน่งครุภัณฑ์ (Equipment Map)

เว็บแอปดูแปลน (PDF) พร้อมปักหมุดตำแหน่งครุภัณฑ์ และดูรูปภาพครุภัณฑ์ — ออกแบบให้รันบน Cloudflare Pages

## โครงสร้าง
| ส่วน | หน้าที่ |
|---|---|
| `tools/ingest.ps1` | อ่านโฟลเดอร์เอกสารปิดโครงการ → สร้าง `public/data/catalog.json` (หมวดงาน/แปลน/รายการ/รูป), คัดลอกแปลน PDF และสกัดรูปจาก xlsx ไปที่ `assets-upload/` |
| `public/` | หน้าเว็บ (HTML/JS/CSS + catalog.json) — deploy ไปที่ Pages |
| `functions/api/state.js` | เก็บหมุด + การผูกรูปใน **KV** (`STATE`) |
| `functions/assets/[[path]].js` | เสิร์ฟแปลน/รูปจาก **R2** (`BUCKET`) พร้อม Range (PDF ใหญ่ ๆ เปิดได้เร็ว) |
| `tools/serve.ps1` | เซิร์ฟเวอร์ทดสอบในเครื่อง (ไม่ต้องมี Node) |

## รันในเครื่อง
```powershell
powershell -ExecutionPolicy Bypass -File tools\ingest.ps1   # ทำครั้งแรก/เมื่อไฟล์ต้นทางเปลี่ยน
powershell -ExecutionPolicy Bypass -File tools\serve.ps1    # เปิด http://localhost:3131
```
หมุดในเครื่องเก็บใน `dev-state.json`

## ขึ้น Cloudflare
แปลนบางไฟล์ใหญ่กว่า 25 MB (ขีดจำกัดไฟล์ของ Pages) จึงเก็บ `assets-upload/` ไว้ใน **R2** ทั้งหมด
```powershell
npx wrangler r2 bucket create equipment-assets
npx wrangler kv namespace create STATE        # แล้วเอา id ไปใส่ wrangler.toml
# อัปโหลดไฟล์ (ใช้ rclone/ S3 API หรือ wrangler r2 object put ทีละไฟล์):
npx wrangler r2 object put equipment-assets/plans/pl1.pdf --file assets-upload/plans/pl1.pdf --remote
npx wrangler pages deploy public --project-name equipment-map
```
จากนั้นใน Pages → Settings → Bindings ให้ตรวจว่ามี `STATE` (KV) และ `BUCKET` (R2)
- **ความปลอดภัย:** แนะนำครอบด้วย Cloudflare Access; หรือตั้ง secret `EDIT_TOKEN` เพื่อให้เฉพาะคนมีรหัสบันทึกหมุดได้ (เว็บจะถามรหัสครั้งแรกที่บันทึก)

## วิธีใช้
1. แท็บ **แปลน** → เลือกแปลน (เลื่อนล้อเมาส์ = ซูม, ลาก = เลื่อน)
2. แท็บ **ครุภัณฑ์** → เลือกรายการ → เปิด **โหมดปักหมุด** → คลิกบนแปลน (วางได้หลายหมุดต่อรายการ ลากเพื่อย้าย, Delete เพื่อลบ)
3. คลิกหมุด/รายการ → แผงขวาแสดงรายละเอียด ตำแหน่ง และรูป; แท็บ **รูปภาพ** ใช้ผูกรูปเพิ่มเอง
4. **ส่งออก/นำเข้า** สำรองหมุดเป็น JSON

## ข้อจำกัดรอบแรก
- รูปจับคู่กับรายการด้วยชื่อ (ประมาณ 686 จาก 3,640 รายการจับคู่ได้) ที่เหลือผูกเองได้
- รูปที่อยู่ใน PDF และรูปแบบ EMF/WMF ในไฟล์ xlsx ยังไม่ถูกสกัด
- ไฟล์ DWG/RAR ยังไม่รองรับ (ใช้ PDF)
- รายการอาจซ้ำข้ามไฟล์ที่เป็นคนละเวอร์ชัน (ตัดซ้ำเฉพาะชื่อ+ชั้น+สถานที่เหมือนกัน)
