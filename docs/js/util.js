// Tiện ích dùng chung: định dạng tiền, ngày giờ, sinh mã, chống chèn HTML.

const nf = new Intl.NumberFormat("vi-VN");

/** 1500000 → "1.500.000đ". sign: true để luôn có dấu +/−. */
export function money(n, { sign = false } = {}) {
  const v = Math.round(Number(n) || 0);
  const s = nf.format(Math.abs(v)) + "đ";
  if (v < 0) return "−" + s;
  return sign && v > 0 ? "+" + s : s;
}

/** Số tiền kèm dấu cho trước, bỏ dấu khi bằng 0: plus(5000) → "+5.000đ", minus(0) → "0đ". */
export const plus = (n) => (n ? "+" : "") + money(n);
export const minus = (n) => (n ? "−" : "") + money(n);

/** Số không có đơn vị: 1500000 → "1.500.000". */
export function num(n) {
  return nf.format(Math.round(Number(n) || 0));
}

/** Rút gọn cho biểu đồ: 1500000 → "1,5tr", 1650000 → "1,65tr", 150000 → "150k", 2e9 → "2 tỷ". */
export function compact(n) {
  const v = Math.abs(Number(n) || 0);
  const neg = n < 0 ? "−" : "";
  // Dưới 10 thì giữ 2 chữ số thập phân, từ 10 trở lên giữ 1 (bỏ số 0 thừa).
  const trim = (x) => {
    const d = x < 10 ? 100 : 10;
    return String(Math.round(x * d) / d).replace(".", ",");
  };
  if (v >= 1e9) return neg + trim(v / 1e9) + " tỷ";
  if (v >= 1e6) return neg + trim(v / 1e6) + "tr";
  if (v >= 1e3) return neg + String(Math.round(v / 1e3)) + "k";
  return neg + String(Math.round(v));
}

/**
 * Đọc số tiền người dùng gõ: "1.500.000", "1500000", "150k", "1tr5", "1,5tr", "2 triệu".
 * Trả về số nguyên đồng, hoặc 0 nếu không đọc được.
 */
export function parseAmount(text) {
  let s = String(text || "").toLowerCase().replace(/\s+/g, "").replace(/đ|₫|vnd/g, "");
  if (!s) return 0;
  // "1tr5" = 1,5 triệu; "2k5" = 2.500
  let m = s.match(/^(\d+)(tr|triệu|trieu|m|k|nghìn|nghin|ngàn|ngan)(\d+)$/);
  if (m) {
    const unit = /^(tr|triệu|trieu|m)$/.test(m[2]) ? 1e6 : 1e3;
    return Math.round(Number(m[1] + "." + m[3]) * unit);
  }
  m = s.match(/^([\d.,]+)(tr|triệu|trieu|m|k|nghìn|nghin|ngàn|ngan|tỷ|ty|tỉ|ti)?$/);
  if (!m) return 0;
  let numPart = m[1];
  const unit = m[2]
    ? /^(tỷ|ty|tỉ|ti)$/.test(m[2])
      ? 1e9
      : /^(tr|triệu|trieu|m)$/.test(m[2])
        ? 1e6
        : 1e3
    : 1;
  if (unit === 1) return Number(numPart.replace(/[.,]/g, "")) || 0;
  // Có đơn vị: dấu , hoặc . là phần thập phân ("1,5tr")
  numPart = numPart.replace(",", ".");
  return Math.round((Number(numPart) || 0) * unit);
}

/** Thoát ký tự HTML để chèn chuỗi người dùng nhập vào innerHTML an toàn. */
export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// Bảng 32 ký tự, bỏ 0/O và 1/I để đọc mã cho nhau không nhầm.
const CODE_ABC = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

/** Mã sổ ngẫu nhiên 12 ký tự (60 bit), dạng "K7QM-3XRP-9TDA". */
export function newCode() {
  const b = crypto.getRandomValues(new Uint8Array(12));
  const s = [...b].map((x) => CODE_ABC[x & 31]).join("");
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
}

/** Chuẩn hóa mã người dùng gõ/dán: bỏ ký tự lạ, viết hoa, chèn gạch. Trả "" nếu sai độ dài. */
export function normCode(text) {
  const s = String(text || "")
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, "");
  if (s.length !== 12) return "";
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
}

// ---------- Ngày giờ (theo giờ trên máy) ----------

export const DAY = 86400000;
export const WEEKDAYS = ["Chủ Nhật", "Thứ Hai", "Thứ Ba", "Thứ Tư", "Thứ Năm", "Thứ Sáu", "Thứ Bảy"];
export const WEEKDAYS_SHORT = ["CN", "T2", "T3", "T4", "T5", "T6", "T7"];

const p2 = (n) => String(n).padStart(2, "0");

export function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function addDays(ts, n) {
  const d = new Date(ts);
  d.setDate(d.getDate() + n);
  return d.getTime();
}

/** Thứ Hai 00:00 của tuần chứa ts. */
export function startOfWeek(ts) {
  const d = new Date(startOfDay(ts));
  const dow = (d.getDay() + 6) % 7; // T2 = 0 … CN = 6
  d.setDate(d.getDate() - dow);
  return d.getTime();
}

export function startOfMonth(ts) {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

export function addMonths(ts, n) {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth() + n, 1).getTime();
}

/** "22/10" */
export function dm(ts) {
  const d = new Date(ts);
  return `${p2(d.getDate())}/${p2(d.getMonth() + 1)}`;
}

/** "5/10" (không thêm số 0, cho nhãn biểu đồ) */
export function dmShort(ts) {
  const d = new Date(ts);
  return `${d.getDate()}/${d.getMonth() + 1}`;
}

/** "22/10/2026" */
export function dmy(ts) {
  const d = new Date(ts);
  return `${p2(d.getDate())}/${p2(d.getMonth() + 1)}/${d.getFullYear()}`;
}

/** "14:05" */
export function hm(ts) {
  const d = new Date(ts);
  return `${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

/** "Tháng 10/2026" */
export function monthLabel(ts) {
  const d = new Date(ts);
  return `Tháng ${d.getMonth() + 1}/${d.getFullYear()}`;
}

/** Tiêu đề nhóm theo ngày: "Hôm nay", "Hôm qua", "Thứ Ba, 20/10/2026". */
export function dayTitle(ts, now = Date.now()) {
  const day = startOfDay(ts);
  const today = startOfDay(now);
  if (day === today) return "Hôm nay";
  if (day === addDays(today, -1)) return "Hôm qua";
  return `${WEEKDAYS[new Date(ts).getDay()]}, ${dmy(ts)}`;
}

/** Giá trị cho <input type="datetime-local">. */
export function toLocalInput(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

export function fromLocalInput(value) {
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : Date.now();
}

/** "vừa xong", "12 giây trước", "3 phút trước", "14:05 22/10". */
export function ago(ts, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 5) return "vừa xong";
  if (s < 60) return `${s} giây trước`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} phút trước`;
  return `${hm(ts)} ${dm(ts)}`;
}
