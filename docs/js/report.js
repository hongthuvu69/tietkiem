// Tính toán cho báo cáo tuần/tháng và cảnh báo hạn mức. Tuần tính từ Thứ Hai đến Chủ Nhật.
import { store } from "./store.js";
import { addDays, addMonths, startOfDay, startOfWeek } from "./util.js";

// Danh mục: key lưu trong dữ liệu, tên và biểu tượng để hiển thị.
export const CATS = {
  out: [
    { key: "an", name: "Ăn uống", icon: "🍜" },
    { key: "dilai", name: "Đi lại", icon: "🛵" },
    { key: "muasam", name: "Mua sắm", icon: "🛍️" },
    { key: "hoadon", name: "Hóa đơn", icon: "🧾" },
    { key: "giaitri", name: "Giải trí", icon: "🎬" },
    { key: "suckhoe", name: "Sức khỏe", icon: "💊" },
    { key: "qua", name: "Quà, hiếu hỉ", icon: "🎁" },
    { key: "khac", name: "Khác", icon: "📌" },
  ],
  in: [
    { key: "luong", name: "Lương", icon: "💼" },
    { key: "thuong", name: "Thưởng", icon: "🎉" },
    { key: "gui", name: "Bỏ ống", icon: "🐷" },
    { key: "lai", name: "Tiền lãi", icon: "📈" },
    { key: "khac", name: "Khác", icon: "📌" },
  ],
};

export function catInfo(kind, key) {
  const list = CATS[kind === "in" ? "in" : "out"];
  return list.find((c) => c.key === key) || list[list.length - 1];
}

/** Giao dịch có thời điểm trong [start, end). */
export function between(start, end) {
  return store.list().filter((e) => e.at >= start && e.at < end);
}

/** Số dư ngay trước thời điểm ts. */
export function balanceBefore(ts) {
  let bal = store.wallet.initial;
  for (const e of store.list()) {
    if (e.at >= ts) break;
    bal += e.kind === "in" ? e.amount : -e.amount;
  }
  return bal;
}

/** Tổng hợp một khoảng thời gian. */
export function summarize(start, end) {
  const list = between(start, end);
  let tin = 0;
  let tout = 0;
  const cats = new Map();
  const people = new Map();
  for (const e of list) {
    if (e.kind === "in") tin += e.amount;
    else {
      tout += e.amount;
      const c = catInfo("out", e.cat);
      cats.set(c.key, (cats.get(c.key) || 0) + e.amount);
    }
    const who = e.by || "Không rõ";
    const p = people.get(who) || { in: 0, out: 0, count: 0 };
    p[e.kind] += e.amount;
    p.count++;
    people.set(who, p);
  }
  const byCat = [...cats.entries()]
    .map(([key, amount]) => ({ ...catInfo("out", key), amount }))
    .sort((a, b) => b.amount - a.amount);
  const byPerson = [...people.entries()].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.out - a.out);
  const top = list
    .filter((e) => e.kind === "out")
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 5);
  const startBal = balanceBefore(start);
  return {
    start,
    end,
    list,
    in: tin,
    out: tout,
    net: tin - tout,
    count: list.length,
    byCat,
    byPerson,
    top,
    startBal,
    endBal: startBal + tin - tout,
  };
}

/** Tổng chi trong tuần bắt đầu từ Thứ Hai wk. */
export function weekSpent(wk) {
  let out = 0;
  const end = addDays(wk, 7);
  for (const e of store.list()) {
    if (e.at >= end) break;
    if (e.at >= wk && e.kind === "out") out += e.amount;
  }
  return out;
}

/** Mức cảnh báo: "" (ổn), "near" (từ 80% hạn mức), "over" (vượt hạn mức). */
export function limitLevel(spent, limit) {
  if (!limit) return "";
  if (spent > limit) return "over";
  if (spent >= limit * 0.8) return "near";
  return "";
}

/** Thu/chi từng ngày, từ ngày start, `days` ngày. */
export function daily(start, days) {
  const rows = [];
  for (let i = 0; i < days; i++) {
    const s = addDays(start, i);
    rows.push({ start: s, end: addDays(start, i + 1), in: 0, out: 0, count: 0 });
  }
  const end = rows.length ? rows[rows.length - 1].end : start;
  for (const e of store.list()) {
    if (e.at < start || e.at >= end) continue;
    const r = rows.find((x) => e.at >= x.start && e.at < x.end);
    if (!r) continue;
    r[e.kind] += e.amount;
    r.count++;
  }
  return rows;
}

/** n tuần liền nhau kết thúc ở tuần lastWk (tính cả lastWk). */
export function weeks(lastWk, n) {
  const rows = [];
  for (let i = n - 1; i >= 0; i--) {
    const s = addDays(lastWk, -7 * i);
    rows.push({ start: s, end: addDays(s, 7), in: 0, out: 0, count: 0 });
  }
  fill(rows);
  return rows;
}

/** n tháng liền nhau kết thúc ở tháng lastMonth. */
export function months(lastMonth, n) {
  const rows = [];
  for (let i = n - 1; i >= 0; i--) {
    const s = addMonths(lastMonth, -i);
    rows.push({ start: s, end: addMonths(s, 1), in: 0, out: 0, count: 0 });
  }
  fill(rows);
  return rows;
}

function fill(rows) {
  if (!rows.length) return;
  const lo = rows[0].start;
  const hi = rows[rows.length - 1].end;
  for (const e of store.list()) {
    if (e.at < lo || e.at >= hi) continue;
    const r = rows.find((x) => e.at >= x.start && e.at < x.end);
    if (!r) continue;
    r[e.kind] += e.amount;
    r.count++;
  }
}

/** Các tuần (Thứ Hai) có ít nhất một ngày nằm trong tháng bắt đầu từ ms. */
export function weeksOfMonth(ms) {
  const end = addMonths(ms, 1);
  const rows = [];
  for (let wk = startOfWeek(ms); wk < end; wk = addDays(wk, 7)) {
    rows.push({ start: wk, end: addDays(wk, 7), out: weekSpent(wk) });
  }
  return rows;
}

/** Ngày đầu tiên có dữ liệu (để giới hạn nút lùi kỳ báo cáo). */
export function firstDay() {
  const list = store.list();
  return list.length ? startOfDay(list[0].at) : startOfDay(Date.now());
}
