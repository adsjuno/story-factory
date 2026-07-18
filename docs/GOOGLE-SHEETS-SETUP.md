# Cài Google Sheets nhận truyện (16 cột) — làm 1 lần, ~3 phút

Phần mềm ghi mỗi bài thành **1 dòng, 16 cột** qua Google Apps Script Web App (miễn phí, không cần API key). n8n sẽ đọc các cột này để đăng lên WordPress + Facebook.

## 16 cột (thứ tự cố định — n8n cào theo thứ tự này)

| # | Cột | Nội dung | n8n dùng để |
|---|---|---|---|
| A | timestamp | Ngày giờ tạo | Sắp xếp |
| B | status | new / posted_web / posted_fb / done | Biết bài nào chưa đăng |
| C | page_target | Ngách/page | Đăng đúng page |
| D | web_title | Tiêu đề web (SEO) | Tiêu đề WordPress |
| E | web_slug | Đường dẫn URL | Link web |
| F | web_body | Bài web Part 1/2/3 | Nội dung WordPress |
| G | web_image_prompt | Mô tả ảnh trong bài | Gemini tạo ảnh bài |
| H | fb_caption_a | Caption FB bản A (dài) | Đăng FB (test A) |
| I | fb_caption_b | Caption FB bản B (ngắn) | Đăng FB (test B) |
| J | fb_cta | Câu "Type YES..." | Ghép cuối caption |
| K | fb_image_prompt | Mô tả ảnh mồi FB | Gemini tạo ảnh FB |
| L | fb_comment_link | [LINK] | Chỗ thả link vào comment |
| M | web_url | Link web thật | n8n điền sau khi đăng web |
| N | dedup_config | Cấu hình chống lặp | Sổ cái |
| O | reveal_type | Kiểu lật mở | Chống lặp reveal |
| P | kpi_scores | Điểm KPI | Kiểm tra chất lượng |

## Các bước

1. Vào [sheets.new](https://sheets.new) → tạo Google Sheet mới, đặt tên (ví dụ: `Story Factory`).
2. Menu **Extensions → Apps Script**.
3. Xoá code mẫu, **dán toàn bộ code dưới đây**, bấm 💾 Lưu:

```javascript
function doPost(e) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  var HEADER = ['timestamp','status','page_target','web_title','web_slug','web_body',
    'web_image_prompt','fb_caption_a','fb_caption_b','fb_cta',
    'fb_image_prompt','fb_comment_link','web_url','dedup_config',
    'reveal_type','kpi_scores'];
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
- Cột M (web_url) và L (fb_comment_link) để n8n điền sau khi đăng — phần mềm để trống/[LINK].
