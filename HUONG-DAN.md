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
   → Claude chạy pipeline, trả về theo khuôn ===CỘT===
   → (nếu bật QA) gõ tiếp "/story-title-qa" TRONG CÙNG đoạn chat để soát tiêu đề/CTA
   → phần mềm bóc tách thành 22 cột
   → phần mềm tự tạo 5 ảnh bằng Cloudflare Workers AI (FLUX 2 klein-9b), up lên R2,
     chèn link ảnh vào bài, rồi đẩy bài đó lên Google Sheet NGAY
   → (n8n đọc Sheet → đăng WordPress + Facebook + thả link comment)
```

## Kiểm tiêu đề bằng CODE + QA cho CTA/số liệu (bước 2, chung đoạn chat)

Sau khi Claude viết xong bài, phần mềm **không mở chat mới** mà làm tiếp trong cùng đoạn chat:

**2a. QA CTA + số liệu** (skill `/story-title-qa`, mặc định BẬT — Cài đặt → "Chạy QA tiêu đề sau khi viết"):
- Trả `===QA_REPORT===` (ghi Log). Nếu trả `===CTA===` mới → **ghi đè** fb_cta.
- Tiêu đề KHÔNG còn lấy từ skill (Claude tự chấm tiêu đề của nó không đáng tin).
- QA lỗi/timeout → bỏ qua CTA/số liệu, không làm hỏng bài.

**2b. Kiểm tiêu đề bằng CODE** (luôn chạy, luật cố định — không hỏi ý AI):
- Quá **20 từ** → lỗi.
- Chứa **cụm lộ kết** → lỗi: "then/until a…" sau gạch ngang/chấm; "a/the + colonel/judge/
  doctor/stranger/veteran…"; "stood up", "said her name", "the whole town", "revealed",
  "learned the truth"…
- Lỗi → gõ prompt ngắn nêu **đích danh** lỗi, bắt Claude viết lại (tối đa 3 lần), kiểm lại mỗi lần.
- Hết lượt vẫn lỗi → **tự cắt**: bỏ phần lộ kết, giữ ≤20 từ, log cảnh báo.
- Log rõ: số từ trước→sau, cụm vi phạm, đã viết lại mấy lần.

Tắt QA để nhanh hơn — nhưng **bước kiểm tiêu đề (2b) vẫn chạy** (chỉ dùng Claude khi tiêu đề lỗi).

**2c. Kiểm cold open bằng CODE** (luôn chạy): 3 thẻ `<p>` đầu sau `<h2>Part 1</h2>`. Đoạn đầu
>40 từ hoặc 3 đoạn >120 từ → lỗi → bắt Claude viết lại phần mở đầu (`===COLD_OPEN===`), chèn vào
đầu Part 1 giữ nguyên phần còn lại, tối đa 2 lần. Hết lượt vẫn lỗi → giữ nguyên bài gốc (không tự chèn).

**2d. Kiểm CTA bằng CODE** (luôn chạy): FAIL nếu đòi comment/type YES ("type yes", "for part 2"…)
hoặc lộ người/vật sẽ xuất hiện ("what the man", "who walked in"…) → bắt viết lại, tối đa 2 lần.
Hết lượt → thay bằng câu mặc định an toàn "The rest of the story is in the first comment."

**HOOK_VARIANTS** (nếu skill xuất): parse + ghi vào Log để xem 3 phương án caption + điểm. Không có
cũng không lỗi. Chưa thêm cột Sheet.

Cold open giờ kiểm **5 đoạn** đầu: đoạn 1 ≤40 từ, 3 đoạn đầu ≤120 từ, **đoạn 4 và 5 mỗi đoạn ≤60 từ**
(chống Claude viết 3 dòng ngắn rồi đoạn 4 lại tả cảnh dài làm khựng nhịp). Lỗi → bắt viết lại 5 dòng
(3 cold + 2 chuyển tiếp ngắn).

## Chống lặp theo chủ đề (legacy_theme)

Hai bài **liền kề** không được cùng legacy_theme (loại các subcategory trùng theme bài ngay trước;
subcategory để rỗng theme thì không bị ràng buộc). Áp cả trong sổ tạm test nhanh. Ngoài ra cap
mỗi kiểu reveal ≤25% giờ có hiệu lực ngay từ bài thứ 3 (trước đây cần ≥4 bài mới chặn).

**Đẩy Sheet từng bài một**, không gom đến cuối. Nếu đang chạy 10 bài mà máy tắt ở bài thứ 7
thì 6 bài đầu đã nằm trên Sheet rồi. Bài nào đẩy lỗi thì log báo rõ và chạy tiếp bài sau.

## Nút Dừng

Trong lúc đang chạy, nút "Bắt đầu viết" đổi thành **⏹ Dừng**. Bấm Dừng thì:
- Bài đang viết dở vẫn được viết cho xong rồi mới dừng (không mất công).
- Các bài còn lại không chạy. Log ghi "Đã dừng theo yêu cầu — còn N bài chưa chạy".
- Nếu đang tạo ảnh thì dừng luôn phần ảnh, bài đó được đánh dấu `need_image` để chạy lại sau.

## Chế độ Test nhanh

Test nhanh bỏ qua tạo ảnh và **không ghi vào sổ chống trùng dài hạn** (giữ sạch cooldown của
bài thật). Nhưng các bài trong **cùng một lần bấm "Bắt đầu viết"** vẫn thấy nhau qua một
**sổ tạm trong phiên**, nên vẫn xoay page và không lặp subcategory / vật biểu tượng /
kiểu reveal / kiểu công lý. Sổ tạm xoá khi kết thúc lượt chạy.

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
