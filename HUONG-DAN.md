# Story Factory — Hướng dẫn chạy & build

Phần mềm tự viết truyện Mỹ 55+ bằng cách điều khiển Claude (đăng nhập, không API), rồi đẩy lên Google Sheet cho n8n đăng WordPress + Facebook.

## Chạy thử trên máy (dev)

1. Cài Node.js (nếu chưa có).
2. Mở thư mục này trong terminal, chạy:
   ```
   npm install
   npm start
   ```
3. Đăng nhập bằng tài khoản nhân viên (Supabase — như phần mềm cũ).
4. Vào **Cài đặt**:
   - Bấm **Đăng nhập Claude** → đăng nhập tài khoản Claude của anh → đóng cửa sổ.
   - Dán **URL Google Sheets** (xem `docs/GOOGLE-SHEETS-SETUP.md`) → Lưu → Ghi thử 1 dòng.
5. Vào **Viết bài** → chọn ngách → nhập số bài → **Bắt đầu viết**.

## Build ra file cài (.exe)

```
npm run build:win
```
File cài nằm trong thư mục `dist/`.

## Cách phần mềm hoạt động

```
Nhân viên bấm "Viết bài"
   → phần mềm gửi câu lệnh gọi skill "story-us-senior-viral" vào cửa sổ Claude login
   → Claude chạy pipeline 11 bước, trả về theo khuôn ===CỘT===
   → phần mềm bóc tách thành 16 cột, đẩy lên Google Sheet
   → (n8n đọc Sheet → Gemini tạo ảnh → đăng WordPress + Facebook + thả link comment)
```

## Yêu cầu QUAN TRỌNG

- **Tài khoản Claude đang đăng nhập trong phần mềm PHẢI đã "Save skill" `story-us-senior-viral`.**
  Vì dùng chung 1 acc Claude của anh nên chỉ cần Save 1 lần. Skill nằm sẵn trong tài khoản, câu lệnh `/story-us-senior-viral` sẽ gọi được.
- Nếu đổi tài khoản Claude khác chưa có skill → vào Cài đặt → sửa "Câu lệnh gọi skill" thành dán trực tiếp nội dung skill (nâng cao).

## Tùy biến (trong Cài đặt)

- **Ngách:** thêm/sửa/xoá dòng `Mã | Tên ngách`.
- **Câu lệnh gọi skill:** sửa được, nhưng giữ `{NICHE}` và các nhãn `===...===` để phần mềm bóc tách đúng.

## Các file chính

- `src/main/webai-electron.js` — điều khiển Claude login (GIỮ NGUYÊN từ bản cũ, đã chạy tốt)
- `src/main/story-writer.js` — BỘ NÃO MỚI: gọi skill, tách 16 cột
- `src/main/sheets.js` — ghi 16 cột lên Google Sheet
- `src/main/main.js` — nối mọi thứ, IPC
- `src/renderer/` — giao diện
