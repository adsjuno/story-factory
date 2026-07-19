# Cài Google Sheets nhận truyện (21 cột) — làm 1 lần, ~3 phút

Phần mềm ghi mỗi bài thành **1 dòng, 21 cột** qua Google Apps Script Web App (miễn phí, không cần API key). n8n sẽ đọc các cột này để đăng lên WordPress + Facebook.

> ⚠️ **Nâng cấp từ bản 16 cột cũ:** bộ cột đã đổi (thêm `story_id`, tách 3 prompt ảnh web, thêm `fb_image_url`/`thumbnail_url`, các cột JSON). Nếu bạn đang dùng Sheet cũ: tạo **Sheet mới** (khuyên dùng) hoặc xoá dòng header cũ + cập nhật lại code Apps Script bên dưới rồi **Deploy → New version**.

## 21 cột (thứ tự cố định — n8n cào theo thứ tự này)

| # | Cột | Nội dung | n8n dùng để |
|---|---|---|---|
| A | story_id | Mã bài `ST` + 8 số (ST00000001) | Khoá định danh, đặt tên ảnh |
| B | timestamp | Ngày giờ tạo | Sắp xếp |
| C | status | new / need_image / posted_web / posted_fb / done | Biết bài nào chưa đăng / cần tạo lại ảnh |
| D | page_target | Ngách/page | Đăng đúng page |
| E | web_title | Tiêu đề web (SEO) | Tiêu đề WordPress |
| F | web_slug | Đường dẫn URL | Link web |
| G | web_body | Bài web HTML gộp 3 Part (đã chèn link ảnh) | Nội dung WordPress |
| H | fb_caption_a | Caption FB bản A (dài) | Đăng FB (test A) |
| I | fb_caption_b | Caption FB bản B (ngắn) | Đăng FB (test B) |
| J | fb_cta | Câu "Type YES..." | Ghép cuối caption |
| K | fb_comment_link | [LINK] | Chỗ thả link vào comment |
| L | web_url | Link web thật | n8n điền sau khi đăng web |
| M | fb_image_url | Link ảnh mồi FB (R2) | Ảnh đăng FB |
| N | thumbnail_url | Thumbnail (dùng chung link ảnh FB) | Thumbnail WP/FB |
| O | fb_image_prompt | Prompt ảnh FB (Human Conflict) | Tạo lại ảnh nếu cần |
| P | web_p1_prompt | Prompt ảnh Part 1 | Tạo lại ảnh nếu cần |
| Q | web_p2_prompt | Prompt ảnh Part 2 | Tạo lại ảnh nếu cần |
| R | web_p3_prompt | Prompt ảnh Part 3 | Tạo lại ảnh nếu cần |
| S | dedup_config | JSON chống lặp | Sổ cái |
| T | story_dna | JSON ADN truyện (reveal...) | Chống lặp reveal |
| U | kpi_scores | JSON điểm KPI (số) | Kiểm tra chất lượng |

## Các bước

1. Vào [sheets.new](https://sheets.new) → tạo Google Sheet mới, đặt tên (ví dụ: `Story Factory`).
2. Menu **Extensions → Apps Script**.
3. Xoá code mẫu, **dán toàn bộ code dưới đây**, bấm 💾 Lưu:

```javascript
function doPost(e) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  var HEADER = ['story_id','timestamp','status','page_target','web_title','web_slug','web_body',
    'fb_caption_a','fb_caption_b','fb_cta','fb_comment_link','web_url',
    'fb_image_url','thumbnail_url','fb_image_prompt','web_p1_prompt','web_p2_prompt','web_p3_prompt',
    'dedup_config','story_dna','kpi_scores'];
  try {
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(HEADER);
      sheet.getRange(1, 1, 1, HEADER.length).setFontWeight('bold');
      sheet.setFrozenRows(1);
    }
    var data = JSON.parse(e.postData.contents);
    // Ho tro ca 1 dong (row) lan nhieu dong (rows)
    var rows = data.rows || (data.row ? [data.row] : null);
    if (!rows || !rows.length) throw new Error('Thiếu dữ liệu rows');
    for (var i = 0; i < rows.length; i++) sheet.appendRow(rows[i]);
    return ContentService.createTextOutput(JSON.stringify({ ok: true, written: rows.length }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
```

4. **Deploy → New deployment** → ⚙ chọn **Web app**:
   - **Execute as:** `Me`
   - **Who has access:** `Anyone` ← BẮT BUỘC
5. **Deploy** → Authorize → chọn tài khoản → *Advanced → Go to ... (unsafe)* → **Allow**.
6. Copy **Web app URL** (dạng `https://script.google.com/macros/s/AKfy.../exec`).
7. Mở phần mềm → **Cài đặt → Google Sheets** → dán URL → **Lưu** → **Ghi thử 1 dòng** → mở Sheet thấy dòng test là XONG. ✅

## Lưu ý

- Sửa code Apps Script sau này: **Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy** (URL giữ nguyên).
- Cột L (web_url) và K (fb_comment_link) để n8n điền sau khi đăng — phần mềm để trống/[LINK].
- Ảnh: phần mềm tạo bằng Gemini + up Cloudflare R2 (Cài đặt → **Ảnh & Lưu trữ**). Nếu chưa cấu hình hoặc tạo ảnh lỗi, bài vẫn được đẩy: cột ảnh để trống, `status = need_image` để chạy lại sau, các cột `*_prompt` vẫn giữ để tạo lại.
