# ตั้งค่า Google Sheet + Drive + GitHub Pages (ไม่ใช้ Cloudflare)

เว็บ: GitHub Pages | ฐานข้อมูลหมุด: Google Sheet | แปลน/รูป: Google Drive | ตัวกลาง: Google Apps Script

## 1) อัปโหลดแปลนและรูปไป Google Drive
1. drive.google.com สร้างโฟลเดอร์ชื่อ `equipment-assets`
2. ลากโฟลเดอร์ `plans` และ `photos` (จาก `equipment-map\assets-upload`) เข้าไปในโฟลเดอร์นั้น
3. คลิกขวาโฟลเดอร์ `photos` -> แชร์ -> General access: **Anyone with the link (Viewer)** (จำเป็นสำหรับแสดงรูป)
   โฟลเดอร์ `plans` ไม่ต้องแชร์ ระบบดึงผ่านสคริปต์ที่รันด้วยบัญชีคุณ
4. เปิดโฟลเดอร์ `equipment-assets` คัดลอกรหัสท้าย URL (`drive.google.com/drive/folders/<รหัสนี้>`)

## 2) Google Sheet + Apps Script
1. สร้าง Google Sheet ใหม่ ชื่อ `equipment-map-db`
2. เมนู Extensions -> Apps Script -> ลบโค้ดเดิม วางเนื้อหาไฟล์ `apps-script/Code.gs`
3. แก้ `ROOT_FOLDER_ID` เป็นรหัสโฟลเดอร์จากข้อ 1.4 แล้วกด Save
4. เลือกฟังก์ชัน `buildIndex` -> Run -> อนุญาตสิทธิ์ (Drive/Sheets) -> รอจนขึ้น `indexed 981 files`
5. Deploy -> New deployment -> Web app -> Execute as: **Me**, Who has access: **Anyone** -> Deploy -> คัดลอก URL (ลงท้าย `/exec`)
6. (ไม่บังคับ) Project Settings -> Script properties -> เพิ่ม `EDIT_TOKEN` เพื่อให้เฉพาะคนที่มีรหัสบันทึกได้

## 3) ใส่ URL ในเว็บ
แก้ `public/config.js`: `window.CFG = { api: 'URL ที่คัดลอก' };` แล้ว commit/push
เว็บอยู่ที่ https://ommelody.github.io/equipment-map/

ข้อควรรู้
- ชีต `pins` และ `links` คือข้อมูลหมุด เปิดดู/แก้ใน Sheet ได้โดยตรง ชีต `files` คือดัชนีไฟล์
- แปลนโหลดผ่านสคริปต์เป็นก้อน ๆ ครั้งแรกของไฟล์ใหญ่ช้ากว่าปกติ
- การบันทึกคือเขียนทับทั้งชุด ถ้าสองคนแก้พร้อมกัน คนที่บันทึกทีหลังชนะ
- Google จำกัดโควต้า Apps Script ต่อวัน การใช้ภายในทีมเล็กไม่น่าเกิน

## 4) (แนะนำ) โหลดแปลนตรงจาก Drive ให้เร็ว
แปลนผ่าน Apps Script ช้า (ไฟล์ 22 MB เกิน 30 วินาที) วิธีโหลดตรงจาก Drive API ใช้เวลาไม่กี่วินาที
1. console.cloud.google.com -> สร้างโปรเจกต์ -> APIs & Services -> Library -> เปิด **Google Drive API**
2. Credentials -> Create credentials -> API key -> Edit API key
   - Application restrictions: **Websites** เพิ่ม `https://ommelody.github.io/*` (และ `http://localhost:3140/*` ถ้าจะทดสอบในเครื่อง)
   - API restrictions: Restrict key -> เลือก Google Drive API
3. ใน Drive แชร์โฟลเดอร์ `plans` เป็น **Anyone with the link (Viewer)** ด้วย (ต้องแชร์ ไม่เช่นนั้น key ใช้อ่านไฟล์ไม่ได้)
4. ใส่ key ใน `public/config.js` ที่ `driveKey: '...'` แล้ว push
ถ้าโหลดตรงไม่สำเร็จ ระบบจะย้อนไปใช้ Apps Script อัตโนมัติ
