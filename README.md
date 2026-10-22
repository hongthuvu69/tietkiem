# Tiết Kiệm Chung: sổ tiết kiệm chung cho 2 iPhone

Web app (PWA) để hai người cùng theo dõi một quỹ tiết kiệm trên hai iPhone. Thêm hay chi tiền ở máy nào thì máy kia cũng thấy sau tối đa 15 giây.

- **Số tiền ban đầu**, mỗi lần **＋ Thêm tiền** hoặc **－ Chi tiêu**. App tự tính số dư, và số còn lại sau từng giao dịch.
- **Lịch sử** nhóm theo ngày, có tìm kiếm (gõ không dấu cũng được), lọc Thêm/Chi, sửa và xóa (có Hoàn tác).
- **Báo cáo tuần** (Thứ Hai – Chủ Nhật) và **báo cáo tháng**: tổng thêm/chi, chênh lệch, số dư đầu và cuối kỳ, so với kỳ trước, biểu đồ chi theo ngày, 8 tuần / 6 tháng gần nhất, chi theo danh mục, theo người nhập, các khoản chi lớn nhất.
- **Cảnh báo chi tiêu**: hạn mức mặc định **1.500.000đ/tuần** (đổi được trong Cài đặt). Đang nhập khoản chi sẽ thấy ngay nếu khoản đó làm tuần vượt hạn mức. Chạm 80% thì có nhắc nhở. Khi vượt thì hiện hộp cảnh báo chi tiết (tổng chi, vượt bao nhiêu, danh mục chi nhiều nhất, khoản lớn nhất và ai nhập) trên **cả hai máy**, mỗi máy một lần mỗi tuần.
- Mất mạng vẫn dùng bình thường. Có mạng lại thì app tự gửi lên.
- Xuất file CSV (mở bằng Excel) để lưu trữ.

App chạy trên GitHub Pages (giống WordFlow). Dữ liệu lưu ở Supabase, dùng chung project với WordFlow, nằm trong các bảng riêng `tk_*`.

## Cài đặt lần đầu

### 1. Supabase: tạo bảng (1 lần, khoảng 1 phút)

1. Mở SQL Editor của project: <https://supabase.com/dashboard/project/gbuydsgtsypfepfxmidd/sql/new>
2. Dán toàn bộ nội dung file [`supabase/schema.sql`](supabase/schema.sql) vào, bấm **Run**. Kết quả đúng là *Success. No rows returned*.

Chạy lại file này nhiều lần cũng không sao: nó không xóa dữ liệu. Các bảng của WordFlow không bị đụng tới.

### 2. GitHub Pages: đưa app lên mạng

1. Tạo repo **trống** tên `tietkiem` trên GitHub (Public, không tick README).
2. Đẩy code lên (nhờ Claude, hoặc tự chạy trong thư mục này):
   ```bash
   git remote add origin https://github.com/hongthuvu69/tietkiem.git
   git push -u origin main
   ```
3. Trên trang repo vào **Settings → Pages** → *Deploy from a branch* → **Branch: `main`**, thư mục **`/docs`** → **Save**.
4. Đợi 1–2 phút rồi mở <https://hongthuvu69.github.io/tietkiem/>

### 3. Hai iPhone

**iPhone thứ nhất**

1. Mở link app bằng **Safari** → nút **Chia sẻ** → **Thêm vào MH chính**.
2. Mở app **từ màn hình chính**. Chọn **Tạo sổ mới**, nhập tên của bạn, số tiền ban đầu và hạn mức chi mỗi tuần.
3. App hiện **mã sổ** dạng `XXXX-XXXX-XXXX`. Bấm **Gửi mã…** để gửi qua Zalo/iMessage cho người kia.

**iPhone thứ hai**

1. Cũng thêm app vào màn hình chính rồi mở từ đó.
2. Chọn **Đã có mã sổ**, nhập tên và mã sổ. Xong!

> App mở từ màn hình chính và app mở trong Safari lưu dữ liệu riêng với nhau. Nếu lỡ tạo sổ trong Safari, chỉ cần mở app ở màn hình chính, chọn **Đã có mã sổ** và nhập mã đó (xem lại mã trong Cài đặt).

Ai có mã sổ thì xem và sửa được sổ, nên chỉ gửi mã cho người dùng chung.

## Đồng bộ hoạt động thế nào

- Mỗi giao dịch có một mã riêng do máy tạo ra, nên gửi lại nhiều lần cũng không bị trùng.
- Thêm/sửa/xóa trên máy nào thì máy đó gửi lên ngay. Khi app đang mở, cứ **15 giây** app kéo thay đổi mới một lần. Mở app lên (từ nền) cũng đồng bộ ngay.
- Hai máy cùng sửa một giao dịch thì **bản sửa sau cùng thắng**. Cài đặt sổ (tên, số tiền ban đầu, hạn mức) cũng vậy.
- Xóa là xóa mềm: giao dịch được đánh dấu đã xóa để máy kia cũng xóa theo.
- Máy chủ chỉ lưu bản băm SHA-256 của mã sổ. Bảng bị khóa với publishable key, app chỉ gọi được 3 hàm `tk_create`, `tk_pull`, `tk_push`, và hàm nào cũng cần đúng mã sổ.

## Cấu trúc

| Đường dẫn | Nội dung |
|---|---|
| `docs/` | Web app (JS thuần, không cần build), là thư mục GitHub Pages phục vụ |
| `docs/js/store.js` | Dữ liệu trên máy (localStorage), hàng chờ gửi, gộp dữ liệu kéo về |
| `docs/js/sync.js` | Gọi Supabase: tạo sổ, đẩy, kéo, lặp lại mỗi 15 giây |
| `docs/js/report.js` | Tính báo cáo tuần/tháng, hạn mức, danh mục |
| `docs/js/charts.js` | Biểu đồ cột SVG tự vẽ |
| `docs/js/app.js` | Giao diện các tab, bảng thêm/sửa giao dịch, cảnh báo |
| `docs/js/config.js` | Địa chỉ Supabase và publishable key (được phép công khai) |
| `docs/sw.js` | Service worker để app mở được khi mất mạng |
| `supabase/schema.sql` | Bảng, bảo mật và 3 hàm API |
| `tools/serve.js` | Server để thử app trên máy: `node tools/serve.js` → <http://localhost:8090> |
| `tools/make_icons.js` | Vẽ lại icon app: `node tools/make_icons.js` |

Sửa xong thì commit và push. Lần mở app tiếp theo (khi có mạng) trên iPhone sẽ có bản mới.
