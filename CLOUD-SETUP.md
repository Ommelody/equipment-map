# ตั้งค่าบนคลาวด์ทั้งหมด (GitHub -> Cloudflare)

ไม่ต้องติดตั้งอะไรในเครื่อง ทุกครั้งที่ push ขึ้น branch `main` GitHub Actions จะ deploy ให้เอง

## ครั้งเดียว บน Cloudflare (dash.cloudflare.com)
1. Workers & Pages -> Create -> Pages -> Direct Upload -> ตั้งชื่อโปรเจกต์ `equipment-map` (อัปโหลดโฟลเดอร์ว่างก็ได้)
2. Storage & databases -> KV -> Create namespace ชื่อ `STATE`
3. Storage & databases -> R2 -> Create bucket ชื่อ `equipment-assets`
4. โปรเจกต์ equipment-map -> Settings -> Bindings: เพิ่ม KV `STATE` และ R2 `BUCKET` (bucket equipment-assets)
5. (ไม่บังคับ) Settings -> Variables and Secrets: เพิ่ม `EDIT_TOKEN` เพื่อจำกัดคนแก้ไขหมุด
6. R2 -> equipment-assets -> Upload: ลากโฟลเดอร์ `plans` และ `photos` (จาก assets-upload) ขึ้นไป
   ไฟล์แปลนเกิน 77 MB ใช้อัปโหลดผ่านเว็บได้ (จำกัด 300 MB/ไฟล์)
7. My Profile -> API Tokens -> Create Token ใช้เทมเพลต "Edit Cloudflare Workers" (ต้องมีสิทธิ์ Cloudflare Pages: Edit) แล้วคัดลอก token
   และคัดลอก Account ID จากหน้า Workers & Pages

## บน GitHub
Repo -> Settings -> Secrets and variables -> Actions -> New repository secret:
- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

จากนั้น Actions -> Deploy to Cloudflare Pages -> Run workflow (หรือ push โค้ดใหม่)

หมายเหตุ: แปลน/รูป (460 MB) ไม่อยู่ใน GitHub เก็บใน R2 เท่านั้น ส่วน catalog.json/assets.json มีข้อมูลจริงของโครงการ ควรใช้ repo แบบ Private
