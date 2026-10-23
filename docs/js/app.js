// Giao diện: điều hướng các tab, vẽ từng màn hình, bảng thêm/sửa giao dịch và cảnh báo hạn mức tuần.
import { store, validAmount, DEFAULT_LIMIT } from "./store.js";
import { sync, SYNC_MS } from "./sync.js";
import * as R from "./report.js";
import { columnChart } from "./charts.js";
import { push } from "./push.js";
import {
  money,
  plus,
  minus,
  num,
  compact,
  parseAmount,
  esc,
  newCode,
  normCode,
  startOfDay,
  startOfWeek,
  startOfMonth,
  addDays,
  addMonths,
  dm,
  dmShort,
  dmy,
  hm,
  monthLabel,
  dayTitle,
  toLocalInput,
  fromLocalInput,
  ago,
  WEEKDAYS,
  WEEKDAYS_SHORT,
} from "./util.js";

const $view = document.getElementById("view");
const $tabbar = document.getElementById("tabbar");
const $sheet = document.getElementById("sheet-root");
const $modal = document.getElementById("modal-root");
const $toast = document.getElementById("toast");

const TABS = ["home", "history", "report", "settings"];

const ui = {
  route: "home",
  reveal: false, // vừa tạo sổ: hiện mã sổ trước khi vào trang chính
  welcomeTab: "create",
  hist: { filter: "all", q: "", limit: 120 },
  rep: { mode: "week", anchor: startOfWeek(Date.now()) },
  mountCharts: null,
  renderPending: false,
};

// ---------- Tiện ích giao diện ----------

const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const standalone = navigator.standalone === true || matchMedia("(display-mode: standalone)").matches;

/** Bỏ dấu tiếng Việt để tìm kiếm: "Ăn uống" → "an uong". */
function fold(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase();
}

/** "Hôm nay 14:05", "Hôm qua 09:30", "20/10 18:00". */
function when(ts) {
  const d = startOfDay(ts);
  const today = startOfDay(Date.now());
  if (d === today) return `Hôm nay ${hm(ts)}`;
  if (d === addDays(today, -1)) return `Hôm qua ${hm(ts)}`;
  return `${dm(ts)} ${hm(ts)}`;
}

function weekLabel(wk) {
  return `${dm(wk)} – ${dm(addDays(wk, 6))}`;
}

function heroMoney(n) {
  const neg = n < 0 ? "−" : "";
  return `<span class="hero-num">${neg}${num(Math.abs(n))}</span><span class="hero-cur">đ</span>`;
}

function toast(text, action) {
  clearTimeout(toast.timer);
  $toast.textContent = "";
  const span = document.createElement("span");
  span.textContent = text;
  $toast.appendChild(span);
  if (action) {
    const b = document.createElement("button");
    b.textContent = action.label;
    b.addEventListener("click", () => {
      action.fn();
      $toast.classList.remove("show");
    });
    $toast.appendChild(b);
  }
  $toast.classList.add("show");
  toast.timer = setTimeout(() => $toast.classList.remove("show"), action ? 7000 : 3200);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {}
    ta.remove();
    return ok;
  }
}

function appUrl() {
  return location.origin + location.pathname;
}

async function shareCode(code) {
  const text = `Mã sổ tiết kiệm chung: ${code}\nMở app: ${appUrl()} → chọn "Đã có mã sổ" rồi nhập mã.`;
  if (navigator.share) {
    try {
      await navigator.share({ title: "Mã sổ Tiết Kiệm", text });
      return;
    } catch (e) {
      if (e && e.name === "AbortError") return;
    }
  }
  if (await copyText(text)) toast("Đã sao chép mã và đường dẫn app");
}

/** Hộp xác nhận thay cho confirm(). Trả về Promise<boolean>. */
function confirmBox({ title, text, ok = "Đồng ý", danger = false }) {
  return new Promise((resolve) => {
    $modal.innerHTML = `
      <div class="modal-bg"></div>
      <section class="modal" role="alertdialog" aria-modal="true" aria-labelledby="cf-title">
        <h2 id="cf-title">${esc(title)}</h2>
        <p>${text}</p>
        <div class="modal-btns">
          <button class="btn" data-cf="0">Hủy</button>
          <button class="btn ${danger ? "btn-danger" : "btn-primary"}" data-cf="1">${esc(ok)}</button>
        </div>
      </section>`;
    const done = (v) => {
      $modal.innerHTML = "";
      resolve(v);
    };
    $modal.querySelector('[data-cf="1"]').addEventListener("click", () => done(true));
    $modal.querySelector('[data-cf="0"]').addEventListener("click", () => done(false));
    $modal.querySelector(".modal-bg").addEventListener("click", () => done(false));
  });
}

// ---------- Định dạng ô nhập tiền (tự thêm dấu chấm hàng nghìn) ----------

function formatMoneyInput(inp) {
  const raw = inp.value;
  if (/[a-zA-Zđ]/.test(raw)) return; // đang gõ kiểu "1tr5", đọc khi rời ô
  const digits = raw.replace(/\D/g, "").replace(/^0+(?=\d)/, "").slice(0, 12);
  const formatted = digits ? num(Number(digits)) : "";
  if (formatted === raw) return;
  const fromEnd = raw.length - (inp.selectionEnd ?? raw.length);
  inp.value = formatted;
  const pos = Math.max(0, formatted.length - fromEnd);
  try {
    inp.setSelectionRange(pos, pos);
  } catch {}
}

document.addEventListener("input", (ev) => {
  if (ev.target.classList && ev.target.classList.contains("money")) formatMoneyInput(ev.target);
});
document.addEventListener(
  "focusout",
  (ev) => {
    const t = ev.target;
    if (t.classList && t.classList.contains("money") && /[a-zA-Zđ]/.test(t.value)) {
      const v = parseAmount(t.value);
      t.value = v ? num(v) : "";
      t.dispatchEvent(new Event("input", { bubbles: true }));
    }
  },
  true
);

const moneyVal = (sel, root = document) => parseAmount((root.querySelector(sel) || {}).value || "");

// ---------- Trạng thái đồng bộ (nút nhỏ góc phải) ----------

let showBusy = false;
let busyTimer = 0;

function pillState() {
  const st = sync.status;
  const pend = store.pendingCount;
  if (st === "busy" && showBusy) return { cls: "busy", text: "Đang đồng bộ…" };
  if (st === "offline") return { cls: "off", text: pend ? `Ngoại tuyến · ${pend} chờ gửi` : "Ngoại tuyến" };
  if (st === "notfound") return { cls: "err", text: "Không thấy sổ" };
  if (st === "setup") return { cls: "warn", text: "Chưa có máy chủ" };
  if (st === "error") return { cls: "err", text: "Lỗi đồng bộ" };
  const last = store.state.lastSync;
  if (!last) return { cls: "off", text: "Chưa đồng bộ" };
  return { cls: "ok", text: `Đã đồng bộ · ${ago(last).replace(" trước", "")}` };
}

function pillHtml() {
  return `<button class="pill" id="pill" data-action="sync" aria-live="polite"><i></i><span></span></button>`;
}

function syncDetail() {
  const st = sync.status;
  const map = {
    ok: "Đã đồng bộ",
    busy: "Đang đồng bộ…",
    idle: "Chờ đồng bộ",
    offline: "Mất kết nối — dữ liệu vẫn lưu trên máy, có mạng sẽ tự gửi",
    notfound: "Không tìm thấy sổ trên máy chủ (mã sai hoặc sổ đã bị xóa)",
    setup: "Máy chủ chưa được cài đặt: chạy file supabase/schema.sql trên Supabase",
    error: sync.message || "Lỗi đồng bộ",
  };
  return map[st] || st;
}

function updatePill() {
  const p = document.getElementById("pill");
  if (p) {
    const s = pillState();
    p.className = "pill " + s.cls;
    p.querySelector("span").textContent = s.text;
    p.title = syncDetail();
  }
  const d = document.getElementById("sync-detail");
  if (d) d.textContent = syncDetail();
  const l = document.getElementById("sync-last");
  if (l) l.textContent = store.state.lastSync ? `${hm(store.state.lastSync)} ${dmy(store.state.lastSync)} (${ago(store.state.lastSync)})` : "Chưa có";
  const q = document.getElementById("sync-pending");
  if (q) q.textContent = store.pendingCount ? `${store.pendingCount} thay đổi` : "Không có";
  const rs = document.getElementById("reveal-status");
  if (rs) {
    const ok = store.state.created && sync.status === "ok";
    rs.className = "reveal-status " + (ok ? "ok" : sync.status === "busy" || sync.status === "idle" ? "busy" : "err");
    rs.textContent = ok ? "✓ Sổ đã lưu lên máy chủ, iPhone kia nhập mã là dùng chung được." : sync.status === "busy" || sync.status === "idle" ? "Đang lưu sổ lên máy chủ…" : "Chưa lưu được lên máy chủ: " + syncDetail();
  }
}

sync.onChange(() => {
  clearTimeout(busyTimer);
  if (sync.status === "busy") {
    busyTimer = setTimeout(() => {
      showBusy = true;
      updatePill();
    }, 700);
  } else {
    showBusy = false;
    updatePill();
  }
});
setInterval(updatePill, 1000);

// ---------- Điều hướng ----------

function route() {
  const r = location.hash.replace(/^#\/?/, "").split("?")[0];
  if (!store.hasWallet) ui.route = "welcome";
  else if (ui.reveal) ui.route = "reveal";
  else ui.route = TABS.includes(r) ? r : "home";
  render(true);
}

function go(r) {
  const target = "#/" + (r === "home" ? "" : r);
  if (location.hash === target || (r === "home" && (location.hash === "" || location.hash === "#/"))) route();
  else location.hash = target;
}

window.addEventListener("hashchange", route);

function render(scrollTop = false) {
  const views = { home: viewHome, history: viewHistory, report: viewReport, settings: viewSettings, welcome: viewWelcome, reveal: viewReveal };
  const tabbed = TABS.includes(ui.route);
  $tabbar.hidden = !tabbed;
  document.body.classList.toggle("no-tabs", !tabbed);
  if (tabbed) {
    $tabbar.style.setProperty("--i", TABS.indexOf(ui.route));
    for (const a of $tabbar.querySelectorAll("a")) a.classList.toggle("active", a.dataset.tab === ui.route);
  }
  ui.mountCharts = null;
  views[ui.route]();
  updatePill();
  if (ui.mountCharts) ui.mountCharts();
  if (ui.route === "settings") renderNotifyCard();
  if (ui.route === "home") renderNotifyHint();
  if (scrollTop) window.scrollTo(0, 0);
}

function isTyping() {
  const a = document.activeElement;
  return !!(a && $view.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && a.type !== "checkbox");
}

/** Dữ liệu đổi (do mình sửa hoặc máy kia gửi về): vẽ lại, trừ khi đang gõ dở trong màn hình.
 *  Dùng setTimeout thay vì requestAnimationFrame: rAF bị dừng khi trang không được vẽ. */
let renderTimer = 0;
function scheduleRender() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(() => {
    if (isTyping()) {
      ui.renderPending = true;
      return;
    }
    render();
  }, 30);
}
// Chờ 400ms sau khi rời ô nhập: nếu người dùng vừa bấm nút "Lưu" thì nút đó chạy trước rồi mới vẽ lại.
$view.addEventListener("focusout", () => {
  setTimeout(() => {
    if (ui.renderPending && !isTyping()) {
      ui.renderPending = false;
      render();
    }
  }, 400);
});

let resizeTimer = 0;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => ui.mountCharts && ui.mountCharts(), 150);
});

// ---------- Màn hình chào: tạo sổ / nhập mã ----------

function viewWelcome() {
  const hint =
    isIOS && !standalone
      ? `<div class="card hint-card">
          <b>Nên cài app lên màn hình chính trước</b>
          <p>Trong Safari, bấm nút <b>Chia sẻ</b> <span class="ios-share" aria-hidden="true"></span> → <b>Thêm vào MH chính</b>, rồi mở app từ màn hình chính để tạo sổ. App mở từ màn hình chính và Safari lưu dữ liệu riêng với nhau.</p>
        </div>`
      : "";
  const me = esc(store.me.name);
  $view.innerHTML = `
    <div class="welcome">
      <img class="welcome-logo" src="icons/icon-192.png" alt="" width="84" height="84">
      <h1>Tiết Kiệm Chung</h1>
      <p class="welcome-sub">Cùng theo dõi quỹ tiết kiệm trên 2 iPhone. Thêm hay chi tiền ở máy nào, máy kia cũng thấy sau tối đa 15 giây.</p>
      ${hint}
      <div class="seg" role="tablist">
        <button data-wtab="create" class="${ui.welcomeTab === "create" ? "on" : ""}" role="tab">Tạo sổ mới</button>
        <button data-wtab="join" class="${ui.welcomeTab === "join" ? "on" : ""}" role="tab">Đã có mã sổ</button>
      </div>
      <form id="f-create" class="card form" ${ui.welcomeTab === "create" ? "" : "hidden"} autocomplete="off">
        <label class="field"><span>Tên của bạn</span>
          <input id="w-me" maxlength="30" placeholder="VD: Huy" value="${me}" required></label>
        <label class="field"><span>Tên sổ</span>
          <input id="w-name" maxlength="60" value="Quỹ tiết kiệm chung"></label>
        <label class="field"><span>Số tiền ban đầu</span>
          <span class="money-box"><input id="w-initial" class="money" inputmode="numeric" placeholder="0"><i>đ</i></span></label>
        <label class="field"><span>Hạn mức chi mỗi tuần</span>
          <span class="money-box"><input id="w-limit" class="money" inputmode="numeric" value="${num(DEFAULT_LIMIT)}"><i>đ</i></span>
          <small>Chi trong một tuần (Thứ Hai – Chủ Nhật) vượt mức này thì app cảnh báo.</small></label>
        <button type="submit" class="btn btn-primary btn-block">Tạo sổ</button>
        <p class="form-note">Đây là iPhone thứ hai? Chọn <b>Đã có mã sổ</b> và nhập mã từ máy đầu tiên.</p>
      </form>
      <form id="f-join" class="card form" ${ui.welcomeTab === "join" ? "" : "hidden"} autocomplete="off">
        <label class="field"><span>Tên của bạn</span>
          <input id="j-me" maxlength="30" placeholder="VD: Thư" value="${me}" required></label>
        <label class="field"><span>Mã sổ</span>
          <input id="j-code" class="code-input" placeholder="XXXX-XXXX-XXXX" autocapitalize="characters" autocorrect="off" spellcheck="false" maxlength="20" required>
          <small>Xem mã trong <b>Cài đặt</b> trên iPhone đã tạo sổ.</small></label>
        <div class="form-err" id="j-err" role="alert"></div>
        <button type="submit" class="btn btn-primary btn-block" id="j-btn">Tham gia sổ</button>
      </form>
    </div>`;

  $view.querySelector("#f-create").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const name = $view.querySelector("#w-me").value.trim();
    if (!name) return $view.querySelector("#w-me").focus();
    const wallet = {
      name: $view.querySelector("#w-name").value.trim() || "Quỹ tiết kiệm chung",
      initial: moneyVal("#w-initial", $view),
      limit: moneyVal("#w-limit", $view),
    };
    ui.reveal = true;
    store.createLocal(newCode(), wallet, name);
    sync.syncNow();
    route();
  });

  $view.querySelector("#f-join").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const err = $view.querySelector("#j-err");
    const btn = $view.querySelector("#j-btn");
    const name = $view.querySelector("#j-me").value.trim();
    const code = normCode($view.querySelector("#j-code").value);
    err.textContent = "";
    if (!name) return $view.querySelector("#j-me").focus();
    if (!code) {
      err.textContent = "Mã sổ gồm 12 ký tự, dạng XXXX-XXXX-XXXX.";
      return;
    }
    btn.disabled = true;
    btn.textContent = "Đang kiểm tra mã…";
    try {
      await sync.join(code, name);
      ui.reveal = false;
      toast("Đã vào sổ. Dữ liệu sẽ tự đồng bộ mỗi 15 giây.");
      go("home");
      setTimeout(checkWeekAlert, 300);
    } catch (e) {
      err.textContent =
        e.kind === "notfound"
          ? "Không tìm thấy sổ với mã này. Kiểm tra lại mã trên iPhone kia."
          : e.kind === "offline"
            ? "Không kết nối được máy chủ. Kiểm tra mạng rồi thử lại."
            : e.message || "Có lỗi, thử lại sau.";
      btn.disabled = false;
      btn.textContent = "Tham gia sổ";
    }
  });
}

function viewReveal() {
  const code = store.state.code;
  $view.innerHTML = `
    <div class="welcome">
      <div class="reveal-check" aria-hidden="true">✓</div>
      <h1>Đã tạo sổ!</h1>
      <p class="welcome-sub">Đây là <b>mã sổ</b>. Trên iPhone thứ hai, mở app → chọn <b>Đã có mã sổ</b> → nhập mã này để dùng chung.</p>
      <div class="code-box big" id="code-box">${esc(code)}</div>
      <div class="row-btns">
        <button class="btn" data-action="copy-code">Sao chép mã</button>
        <button class="btn" data-action="share-code">Gửi mã…</button>
      </div>
      <div class="reveal-status busy" id="reveal-status">Đang lưu sổ lên máy chủ…</div>
      <p class="form-note">Mã luôn xem lại được trong <b>Cài đặt</b>. Chỉ gửi mã cho người dùng chung sổ.</p>
      <button class="btn btn-primary btn-block" data-action="start">Bắt đầu dùng</button>
    </div>`;
}

// ---------- Tổng quan ----------

function weekCard(wk, { link = false, title = "Chi tiêu tuần này" } = {}) {
  const limit = store.wallet.limit;
  const spent = R.weekSpent(wk);
  const level = R.limitLevel(spent, limit);
  if (!limit) {
    return `<section class="card week-card" ${link ? 'data-action="report-week"' : ""}>
      <div class="card-head"><h2>${title}</h2><span class="muted">${weekLabel(wk)}</span></div>
      <div class="wk-amount"><b>${money(spent)}</b></div>
      <div class="wk-foot muted">Chưa đặt hạn mức chi mỗi tuần (Cài đặt).</div>
    </section>`;
  }
  const pct = Math.min(100, (spent / limit) * 100);
  const past = addDays(wk, 7) <= Date.now();
  const status =
    level === "over"
      ? `<span class="status st-crit"><b aria-hidden="true">⚠</b> Vượt hạn mức</span>`
      : level === "near"
        ? `<span class="status st-warn"><b aria-hidden="true">!</b> Sắp chạm hạn mức</span>`
        : `<span class="status st-good"><b aria-hidden="true">✓</b> Trong hạn mức</span>`;
  const foot =
    level === "over"
      ? `Đã vượt <b class="crit">${money(spent - limit)}</b>`
      : past
        ? `Chi ít hơn hạn mức <b>${money(limit - spent)}</b>`
        : `Còn được chi <b>${money(limit - spent)}</b> đến hết Chủ Nhật`;
  return `<section class="card week-card lvl-${level || "ok"}" ${link ? 'data-action="report-week" role="button" tabindex="0" aria-label="Chi tiêu tuần này, xem báo cáo tuần"' : ""}>
    <div class="card-head"><h2>${title}</h2>${status}</div>
    <div class="wk-amount"><b>${money(spent)}</b><span> / ${money(limit)}</span></div>
    <div class="meter lvl-${level || "ok"}" role="meter" aria-valuemin="0" aria-valuemax="${limit}" aria-valuenow="${spent}" aria-label="Đã chi trong tuần"><span style="width:${pct}%"></span></div>
    <div class="wk-foot"><span>${foot}</span><span class="muted">${weekLabel(wk)}</span></div>
  </section>`;
}

function txRow(e, { full = false } = {}) {
  const c = R.catInfo(e.kind, e.cat);
  const sign = e.kind === "in" ? "+" : "−";
  const sub = [c.name, e.by, full ? hm(e.at) : when(e.at)].filter(Boolean).map(esc).join(" · ");
  const label = `${e.note || c.name}, ${sign}${money(e.amount)}, ${when(e.at)}`;
  return `<li><button class="tx" data-edit="${esc(e.id)}" aria-label="${esc(label)}">
    <span class="tx-ic ${e.kind}" aria-hidden="true">${c.icon}</span>
    <span class="tx-main"><span class="tx-title">${esc(e.note || c.name)}</span><span class="tx-sub">${sub}</span></span>
    <span class="tx-right"><span class="tx-amt ${e.kind}">${sign}${money(e.amount)}</span><span class="tx-bal">Còn ${money(store.balanceAfter(e.id))}</span></span>
  </button></li>`;
}

function viewHome() {
  const w = store.wallet;
  const list = store.list();
  let tin = 0;
  let tout = 0;
  for (const e of list) e.kind === "in" ? (tin += e.amount) : (tout += e.amount);
  const bal = w.initial + tin - tout;
  const now = Date.now();
  const mStart = startOfMonth(now);
  const M = R.summarize(mStart, addMonths(mStart, 1));
  const recent = list.slice(-6).reverse();

  $view.innerHTML = `
    <header class="top top-stack">
      <div class="top-row"><span class="eyebrow">Sổ tiết kiệm</span>${pillHtml()}</div>
      <h1>${esc(w.name)}</h1>
    </header>
    <section class="hero">
      <div class="hero-label">Số dư hiện tại</div>
      <div class="hero-value ${bal < 0 ? "neg" : ""}">${heroMoney(bal)}</div>
      <div class="hero-base">Ban đầu ${money(w.initial)}</div>
      <div class="hero-grid">
        <div><span>Đã thêm</span><b>${plus(tin)}</b></div>
        <div><span>Đã chi</span><b>${minus(tout)}</b></div>
      </div>
    </section>
    <div class="actions">
      <button class="btn btn-in" data-action="add-in"><b aria-hidden="true">＋</b> Thêm tiền</button>
      <button class="btn btn-out" data-action="add-out"><b aria-hidden="true">－</b> Chi tiêu</button>
    </div>
    <div id="notify-hint"></div>
    ${weekCard(startOfWeek(now), { link: true })}
    <section class="card month-card" data-action="report-month" role="button" tabindex="0" aria-label="${monthLabel(now)}, xem báo cáo tháng">
      <div class="card-head"><h2>${monthLabel(now)}</h2><span class="link">Báo cáo ›</span></div>
      <div class="kv"><span>Thêm vào</span><b class="${M.in ? "in" : ""}">${plus(M.in)}</b></div>
      <div class="kv"><span>Chi ra</span><b>${minus(M.out)}</b></div>
      <div class="kv last"><span>Chênh lệch</span><b class="${M.net < 0 ? "neg" : M.net > 0 ? "in" : ""}">${money(M.net, { sign: true })}</b></div>
    </section>
    <section class="card list-card">
      <div class="card-head"><h2>Gần đây</h2>${list.length ? `<a class="link" href="#/history">Xem tất cả ›</a>` : ""}</div>
      ${
        recent.length
          ? `<ul class="tx-list">${recent.map((e) => txRow(e)).join("")}</ul>`
          : `<div class="empty">Chưa có giao dịch nào.<br>Bấm <b>Thêm tiền</b> hoặc <b>Chi tiêu</b> để bắt đầu.</div>`
      }
    </section>`;
}

// ---------- Lịch sử ----------

function viewHistory() {
  const count = store.list().length;
  $view.innerHTML = `
    <header class="top">
      <div class="grow"><h1>Lịch sử</h1><div class="sub">${num(count)} giao dịch</div></div>
      ${pillHtml()}
    </header>
    <div class="search">
      <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
      <input id="q" type="search" placeholder="Tìm ghi chú, danh mục, người nhập…" value="${esc(ui.hist.q)}" autocomplete="off" enterkeyhint="search">
    </div>
    <div class="seg" id="hist-seg">
      <button data-filter="all" class="${ui.hist.filter === "all" ? "on" : ""}">Tất cả</button>
      <button data-filter="in" class="${ui.hist.filter === "in" ? "on" : ""}">Thêm tiền</button>
      <button data-filter="out" class="${ui.hist.filter === "out" ? "on" : ""}">Chi tiêu</button>
    </div>
    <div id="hist-list"></div>`;
  $view.querySelector("#q").addEventListener("input", (ev) => {
    ui.hist.q = ev.target.value;
    ui.hist.limit = 120;
    renderHistList();
  });
  renderHistList();
}

function renderHistList() {
  const box = document.getElementById("hist-list");
  if (!box) return;
  const q = fold(ui.hist.q.trim());
  let list = store.list().slice().reverse();
  if (ui.hist.filter !== "all") list = list.filter((e) => e.kind === ui.hist.filter);
  if (q) list = list.filter((e) => fold(`${e.note} ${R.catInfo(e.kind, e.cat).name} ${e.by} ${e.amount} ${num(e.amount)}`).includes(q));
  const shown = list.slice(0, ui.hist.limit);
  const groups = [];
  for (const e of shown) {
    const d = startOfDay(e.at);
    let g = groups[groups.length - 1];
    if (!g || g.day !== d) groups.push((g = { day: d, items: [], in: 0, out: 0 }));
    g.items.push(e);
    g[e.kind] += e.amount;
  }
  let html = groups
    .map(
      (g) => `<section class="day">
        <div class="day-head"><span>${dayTitle(g.day)}</span><span class="day-tot">${g.in ? `<span class="in">+${money(g.in)}</span>` : ""}${g.out ? `<span>−${money(g.out)}</span>` : ""}</span></div>
        <ul class="tx-list card">${g.items.map((e) => txRow(e, { full: true })).join("")}</ul>
      </section>`
    )
    .join("");
  if (list.length > shown.length) html += `<button class="btn btn-block" data-action="more">Xem thêm (${num(list.length - shown.length)} giao dịch cũ hơn)</button>`;
  else if (!q && ui.hist.filter === "all")
    html += `<div class="start-row"><span>🏁 Số tiền ban đầu</span><b>${money(store.wallet.initial)}</b></div>`;
  if (!shown.length) html = `<div class="empty card">${q || ui.hist.filter !== "all" ? "Không có giao dịch phù hợp." : "Chưa có giao dịch nào."}</div>` + html;
  box.innerHTML = html;
}

// ---------- Báo cáo ----------

function deltaHtml(cur, prev, upIsGood, what) {
  if (!prev && !cur) return `<div class="kpi-sub">&nbsp;</div>`;
  if (!prev) return `<div class="kpi-sub">${what} trước: 0đ</div>`;
  const pct = Math.round(((cur - prev) / prev) * 100);
  if (pct === 0) return `<div class="kpi-sub">Bằng ${what.toLowerCase()} trước</div>`;
  const up = pct > 0;
  const good = up === upIsGood;
  return `<div class="kpi-sub delta ${good ? "good" : "bad"}"><b aria-hidden="true">${up ? "▲" : "▼"}</b> ${up ? "Tăng" : "Giảm"} ${Math.abs(pct)}% so với ${what.toLowerCase()} trước</div>`;
}

function catBars(byCat, total) {
  if (!byCat.length) return `<div class="empty small">Không có khoản chi nào.</div>`;
  const max = byCat[0].amount;
  return `<ul class="bars">${byCat
    .map(
      (c) => `<li>
        <span class="b-name"><span aria-hidden="true">${c.icon}</span> ${esc(c.name)}</span>
        <span class="b-track"><i style="width:${Math.max(2, (c.amount / max) * 100)}%"></i></span>
        <span class="b-val">${money(c.amount)}<small>${Math.round((c.amount / total) * 100)}%</small></span>
      </li>`
    )
    .join("")}</ul>`;
}

function tableView(head, rows) {
  return `<details class="table-view"><summary>Xem bảng số liệu</summary>
    <table><thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table></details>`;
}

function viewReport() {
  const mode = ui.rep.mode;
  const now = Date.now();
  const limit = store.wallet.limit;
  const isWeek = mode === "week";
  const cur = isWeek ? startOfWeek(now) : startOfMonth(now);
  let start = isWeek ? startOfWeek(ui.rep.anchor) : startOfMonth(ui.rep.anchor);
  if (start > cur) start = cur;
  ui.rep.anchor = start;
  const end = isWeek ? addDays(start, 7) : addMonths(start, 1);
  const prev = isWeek ? addDays(start, -7) : addMonths(start, -1);
  const first = isWeek ? startOfWeek(R.firstDay()) : startOfMonth(R.firstDay());
  const S = R.summarize(start, end);
  const P = R.summarize(prev, start);
  const what = isWeek ? "Tuần" : "Tháng";

  const title = isWeek
    ? start === cur
      ? "Tuần này"
      : start === addDays(cur, -7)
        ? "Tuần trước"
        : `Tuần ${weekLabel(start)}`
    : start === cur
      ? "Tháng này"
      : monthLabel(start);
  const sub = isWeek ? `Thứ Hai ${dm(start)} – Chủ Nhật ${dmy(addDays(start, 6))}` : monthLabel(start);

  let limitBlock = "";
  if (isWeek) {
    limitBlock = weekCard(start, { title: "Hạn mức tuần" });
  } else {
    const wks = R.weeksOfMonth(start);
    const over = limit ? wks.filter((w) => w.out > limit).length : 0;
    limitBlock = `<section class="card">
      <div class="card-head"><h2>Các tuần trong tháng</h2>${
        limit
          ? over
            ? `<span class="status st-crit"><b aria-hidden="true">⚠</b> ${over} tuần vượt</span>`
            : `<span class="status st-good"><b aria-hidden="true">✓</b> Không tuần nào vượt</span>`
          : ""
      }</div>
      <ul class="wk-list">${wks
        .map((w) => {
          const lvl = R.limitLevel(w.out, limit);
          const pct = limit ? Math.min(100, (w.out / limit) * 100) : 0;
          return `<li><button data-week="${w.start}">
            <span class="wk-l">${weekLabel(w.start)}</span>
            <span class="meter thin lvl-${lvl || "ok"}"><span style="width:${pct}%"></span></span>
            <b>${money(w.out)}</b>
            ${lvl === "over" ? `<span class="tag crit">⚠ Vượt</span>` : `<span class="tag"></span>`}
          </button></li>`;
        })
        .join("")}</ul>
      <p class="hint">Hạn mức ${limit ? money(limit) : "chưa đặt"}/tuần. Tuần nằm vắt sang tháng khác vẫn tính đủ 7 ngày. Chạm vào một tuần để xem chi tiết.</p>
    </section>`;
  }

  const overBanner =
    isWeek && limit && S.out > limit
      ? `<div class="banner crit" role="alert"><b aria-hidden="true">⚠</b><div><b>Tuần này vượt hạn mức ${money(S.out - limit)}</b><span>Đã chi ${money(S.out)} / ${money(limit)}</span></div></div>`
      : "";

  const people =
    S.byPerson.length > 0
      ? `<section class="card"><div class="card-head"><h2>Theo người nhập</h2></div>
        <ul class="people">${S.byPerson
          .map(
            (p) => `<li><span class="avatar" aria-hidden="true">${esc((p.name[0] || "?").toUpperCase())}</span>
              <span class="p-name">${esc(p.name)}<small>${p.count} giao dịch</small></span>
              <span class="p-val"><b>${minus(p.out)}</b>${p.in ? `<small class="in">${plus(p.in)}</small>` : ""}</span></li>`
          )
          .join("")}</ul></section>`
      : "";

  $view.innerHTML = `
    <header class="top"><div class="grow"><h1>Báo cáo</h1></div>${pillHtml()}</header>
    <div class="seg" id="rep-seg">
      <button data-mode="week" class="${isWeek ? "on" : ""}">Theo tuần</button>
      <button data-mode="month" class="${!isWeek ? "on" : ""}">Theo tháng</button>
    </div>
    <div class="period">
      <button class="icon-btn" data-action="prev" ${start > first ? "" : "disabled"} aria-label="${what} trước">‹</button>
      <div class="period-mid"><div class="period-title">${title}</div><div class="period-sub">${sub}</div></div>
      <button class="icon-btn" data-action="next" ${start < cur ? "" : "disabled"} aria-label="${what} sau">›</button>
    </div>
    ${overBanner}
    <div class="kpis">
      <div class="kpi"><div class="kpi-label">Thêm vào</div><div class="kpi-value ${S.in ? "in" : ""}">${plus(S.in)}</div>${deltaHtml(S.in, P.in, true, what)}</div>
      <div class="kpi"><div class="kpi-label">Chi ra</div><div class="kpi-value">${minus(S.out)}</div>${deltaHtml(S.out, P.out, false, what)}</div>
      <div class="kpi"><div class="kpi-label">Chênh lệch</div><div class="kpi-value ${S.net < 0 ? "neg" : S.net > 0 ? "in" : ""}">${money(S.net, { sign: true })}</div><div class="kpi-sub">${num(S.count)} giao dịch</div></div>
      <div class="kpi"><div class="kpi-label">Số dư cuối ${what.toLowerCase()}</div><div class="kpi-value">${money(S.endBal)}</div><div class="kpi-sub">Đầu ${what.toLowerCase()}: ${money(S.startBal)}</div></div>
    </div>
    ${limitBlock}
    <section class="card"><div class="card-head"><h2>Chi theo ngày</h2><span class="muted">${isWeek ? weekLabel(start) : monthLabel(start)}</span></div>
      <div id="ch-daily" class="chart-host"></div><div id="tv-daily"></div></section>
    <section class="card"><div class="card-head"><h2>${isWeek ? "Chi 8 tuần gần nhất" : "6 tháng gần nhất"}</h2>${
      isWeek ? "" : `<span class="legend"><span><i class="lg-in"></i>Thêm vào</span><span><i class="lg-out"></i>Chi ra</span></span>`
    }</div>
      <div id="ch-trend" class="chart-host"></div>
      <p class="hint">Chạm vào cột để xem ${isWeek ? "tuần" : "tháng"} đó.</p><div id="tv-trend"></div></section>
    <section class="card"><div class="card-head"><h2>Chi theo danh mục</h2>${S.out ? `<span class="muted">${money(S.out)}</span>` : ""}</div>${catBars(S.byCat, S.out)}</section>
    ${people}
    <section class="card list-card"><div class="card-head"><h2>Khoản chi lớn nhất</h2></div>
      ${S.top.length ? `<ul class="tx-list">${S.top.map((e) => txRow(e)).join("")}</ul>` : `<div class="empty small">Không có khoản chi nào.</div>`}
    </section>
    ${
      S.list.length
        ? `<details class="card list-card all-tx"><summary>Tất cả giao dịch trong ${what.toLowerCase()} (${S.list.length})</summary>
            <ul class="tx-list">${S.list
              .slice()
              .reverse()
              .map((e) => txRow(e))
              .join("")}</ul></details>`
        : ""
    }`;

  // Biểu đồ vẽ sau khi khung đã có kích thước thật.
  ui.mountCharts = () => {
    const today = startOfDay(Date.now());
    const days = R.daily(start, isWeek ? 7 : Math.round((end - start) / 86400000));
    const dailyRows = days.map((d) => {
      const dt = new Date(d.start);
      return {
        label: isWeek ? WEEKDAYS_SHORT[dt.getDay()] : String(dt.getDate()),
        values: { out: d.out },
        strong: d.start === today,
        title: `${WEEKDAYS[dt.getDay()]}, ${dmy(d.start)}`,
        lines: [
          { key: "out", name: "chi ra", text: money(d.out) },
          ...(d.in ? [{ key: "in", name: "thêm vào", text: money(d.in) }] : []),
          { name: "giao dịch", text: String(d.count) },
        ],
      };
    });
    const dailyHost = document.getElementById("ch-daily");
    if (!dailyHost) return;
    columnChart(dailyHost, {
      rows: dailyRows,
      series: [{ key: "out" }],
      labelEvery: isWeek ? 1 : 5,
      label: `Chi theo ngày, ${sub}`,
    });
    document.getElementById("tv-daily").innerHTML = tableView(
      ["Ngày", "Chi ra", "Thêm vào"],
      days.filter((d) => d.count).map((d) => [`${WEEKDAYS_SHORT[new Date(d.start).getDay()]} ${dm(d.start)}`, money(d.out), money(d.in)])
    );

    if (isWeek) {
      const span = Math.round((cur - start) / (7 * 86400000));
      const lastWk = span < 8 ? cur : addDays(start, 7 * 3);
      const wks = R.weeks(lastWk, 8);
      columnChart(document.getElementById("ch-trend"), {
        rows: wks.map((w) => ({
          label: dmShort(w.start),
          values: { out: w.out },
          over: !!limit && w.out > limit,
          strong: w.start === start,
          title: `Tuần ${weekLabel(w.start)}`,
          lines: [
            { key: "out", name: "chi ra", text: money(w.out) },
            ...(limit ? [{ name: w.out > limit ? "⚠ vượt hạn mức" : "hạn mức", text: w.out > limit ? money(w.out - limit) : money(limit) }] : []),
          ],
        })),
        series: [{ key: "out" }],
        limit,
        label: "Chi tiêu 8 tuần gần nhất so với hạn mức",
        onPick: (i) => {
          ui.rep.anchor = wks[i].start;
          render();
        },
      });
      document.getElementById("tv-trend").innerHTML = tableView(
        ["Tuần", "Chi ra", "Hạn mức"],
        wks.map((w) => [weekLabel(w.start), money(w.out), !limit ? "—" : w.out > limit ? `⚠ vượt ${money(w.out - limit)}` : "Trong hạn mức"])
      );
    } else {
      const span = (new Date(cur).getFullYear() - new Date(start).getFullYear()) * 12 + new Date(cur).getMonth() - new Date(start).getMonth();
      const lastM = span < 6 ? cur : addMonths(start, 2);
      const ms = R.months(lastM, 6);
      columnChart(document.getElementById("ch-trend"), {
        rows: ms.map((m) => ({
          label: `T${new Date(m.start).getMonth() + 1}`,
          values: { in: m.in, out: m.out },
          strong: m.start === start,
          title: monthLabel(m.start),
          lines: [
            { key: "in", name: "thêm vào", text: money(m.in) },
            { key: "out", name: "chi ra", text: money(m.out) },
            { name: "chênh lệch", text: money(m.in - m.out, { sign: true }) },
          ],
        })),
        series: [{ key: "in" }, { key: "out" }],
        label: "Thêm vào và chi ra 6 tháng gần nhất",
        onPick: (i) => {
          ui.rep.anchor = ms[i].start;
          render();
        },
      });
      document.getElementById("tv-trend").innerHTML = tableView(
        ["Tháng", "Thêm vào", "Chi ra", "Chênh lệch"],
        ms.map((m) => [monthLabel(m.start), money(m.in), money(m.out), money(m.in - m.out, { sign: true })])
      );
    }
  };
}

// ---------- Cài đặt ----------

function viewSettings() {
  const w = store.wallet;
  const code = store.state.code;
  const iosHint = standalone
    ? `<p>App đang chạy từ màn hình chính. 👍</p>`
    : `<ol class="steps">
        <li>Mở trang này bằng <b>Safari</b>.</li>
        <li>Bấm nút <b>Chia sẻ</b> <span class="ios-share" aria-hidden="true"></span> ở thanh dưới.</li>
        <li>Chọn <b>Thêm vào MH chính</b> → <b>Thêm</b>.</li>
      </ol>
      <p class="hint">App trên màn hình chính lưu dữ liệu riêng với Safari: mở app từ màn hình chính rồi nhập mã sổ ở trên.</p>`;
  $view.innerHTML = `
    <header class="top"><div class="grow"><h1>Cài đặt</h1></div>${pillHtml()}</header>

    <section class="card form">
      <h2>Sổ tiết kiệm</h2>
      <label class="field"><span>Tên sổ</span><input id="s-name" maxlength="60" value="${esc(w.name)}"></label>
      <label class="field"><span>Số tiền ban đầu</span>
        <span class="money-box"><input id="s-initial" class="money" inputmode="numeric" value="${num(w.initial)}"><i>đ</i></span></label>
      <label class="field"><span>Hạn mức chi mỗi tuần</span>
        <span class="money-box"><input id="s-limit" class="money" inputmode="numeric" value="${num(w.limit)}"><i>đ</i></span>
        <small>Cảnh báo khi chi trong tuần (Thứ Hai – Chủ Nhật) vượt mức này. Để 0 nếu không cần.</small></label>
      <button class="btn btn-primary btn-block" data-action="save-wallet">Lưu thay đổi</button>
      <p class="form-note">Thay đổi tự đồng bộ sang iPhone kia.</p>
    </section>

    <section class="card form">
      <h2>Máy này</h2>
      <label class="field"><span>Tên của bạn</span><input id="s-me" maxlength="30" placeholder="VD: Huy" value="${esc(store.me.name)}">
        <small>Hiện cạnh mỗi giao dịch bạn nhập, để biết ai thêm/chi.</small></label>
      <button class="btn btn-block" data-action="save-me">Lưu tên</button>
    </section>

    <section class="card">
      <h2>Kết nối iPhone thứ hai</h2>
      <p>Trên iPhone kia: mở app → <b>Đã có mã sổ</b> → nhập mã:</p>
      <div class="code-box">${esc(code)}</div>
      <div class="row-btns">
        <button class="btn" data-action="copy-code">Sao chép mã</button>
        <button class="btn" data-action="share-code">Gửi mã…</button>
      </div>
      <p class="hint">Ai có mã này đều xem và sửa được sổ. Chỉ gửi cho người dùng chung.</p>
    </section>

    <section class="card" id="notify-card">
      <h2>Thông báo trên iPhone</h2>
      <div id="notify-body"><p class="hint">Đang kiểm tra…</p></div>
    </section>

    <section class="card">
      <h2>Đồng bộ</h2>
      <div class="kv"><span>Trạng thái</span><b id="sync-detail"></b></div>
      <div class="kv"><span>Lần cuối</span><b id="sync-last"></b></div>
      <div class="kv"><span>Chờ gửi lên</span><b id="sync-pending"></b></div>
      <p class="hint">Tự đồng bộ mỗi ${SYNC_MS / 1000} giây khi app đang mở, và gửi ngay khi bạn thêm/sửa. Mất mạng vẫn dùng bình thường, có mạng lại sẽ tự gửi.</p>
      <button class="btn btn-block" data-action="sync">Đồng bộ ngay</button>
    </section>

    <section class="card">
      <h2>Cài lên màn hình chính</h2>
      ${iosHint}
    </section>

    <section class="card">
      <h2>Dữ liệu</h2>
      <button class="btn btn-block" data-action="export">Xuất file CSV (mở bằng Excel)</button>
      <button class="btn btn-block btn-ghost-danger" data-action="leave">Rời sổ trên máy này</button>
      <p class="hint">Rời sổ chỉ xóa dữ liệu trên iPhone này. Sổ vẫn còn trên máy chủ và iPhone kia, nhập lại mã là có lại.</p>
    </section>
    <p class="foot">Tiết Kiệm Chung · v1.0</p>`;
}

// ---------- Thông báo đẩy ----------

async function renderNotifyCard() {
  const box = document.getElementById("notify-body");
  if (!box) return;
  const st = await push.status();
  if (!document.body.contains(box)) return;
  const p = store.notify.prefs;
  const sw = (key, label, sub) =>
    `<label class="switch-row"><span>${label}<small>${sub}</small></span><input type="checkbox" data-pref="${key}" ${p[key] ? "checked" : ""}><i aria-hidden="true"></i></label>`;
  const html = {
    install: `<p>Để nhận thông báo, mở app <b>từ biểu tượng trên màn hình chính</b> (Safari → Chia sẻ → Thêm vào MH chính). iPhone cần iOS 16.4 trở lên.</p>`,
    unsupported: `<p>Trình duyệt này chưa hỗ trợ thông báo đẩy. Trên iPhone cần iOS 16.4 trở lên và mở app từ màn hình chính.</p>`,
    denied: `<p>Thông báo đang bị chặn. Vào <b>Cài đặt iPhone → Thông báo → Tiết Kiệm</b> để bật lại, rồi quay lại đây.</p>`,
    off: `<p>Nhận thông báo khi người kia thêm/chi tiền và khi chi gần hoặc quá hạn mức tuần, kể cả lúc không mở app.</p>
      <button class="btn btn-primary btn-block" data-action="notify-on">🔔 Bật thông báo</button>`,
    on: `<p class="notify-on"><b aria-hidden="true">✓</b> Đang bật trên máy này</p>
      ${sw("entries", "Giao dịch mới của người kia", "VD: “Thư vừa chi 350.000đ · Ăn uống”")}
      ${sw("alerts", "Cảnh báo hạn mức tuần", "Khi chi tới 80% và khi vượt hạn mức")}
      ${sw("weekly", "Tổng kết tuần", "20:00 tối Chủ Nhật")}
      <div class="row-btns">
        <button class="btn" data-action="notify-test">Gửi thử</button>
        <button class="btn btn-ghost-danger" data-action="notify-off">Tắt thông báo</button>
      </div>`,
  };
  box.innerHTML = html[st] || html.unsupported;
}

async function renderNotifyHint() {
  const box = document.getElementById("notify-hint");
  if (!box || !store.notify.hint) return;
  const st = await push.status();
  if (st !== "off" || !document.body.contains(box)) return;
  box.innerHTML = `<section class="card notify-hint">
      <b>🔔 Bật thông báo?</b>
      <p>Biết ngay khi người kia chi tiêu và khi tuần này sắp vượt hạn mức, kể cả lúc không mở app.</p>
      <div class="row-btns">
        <button class="btn" data-action="notify-hint-close">Để sau</button>
        <button class="btn btn-primary" data-action="notify-on">Bật thông báo</button>
      </div>
    </section>`;
}

// ---------- Bảng thêm / sửa giao dịch ----------

function closeSheet() {
  const sh = $sheet.querySelector(".sheet");
  if (!sh) return;
  document.body.classList.remove("locked");
  $sheet.classList.add("closing");
  setTimeout(() => {
    $sheet.classList.remove("closing");
    $sheet.innerHTML = "";
  }, 180);
}

function openEntrySheet(kind, entry = null) {
  $sheet.classList.remove("closing");
  const editing = !!entry;
  const st = { kind: entry ? entry.kind : kind, cat: entry ? entry.cat : "" };
  const quick = [10000, 20000, 50000, 100000, 200000, 500000, 1000000];
  $sheet.innerHTML = `
    <div class="sheet-bg" data-close></div>
    <section class="sheet" role="dialog" aria-modal="true" aria-labelledby="sh-title">
      <header class="sheet-head">
        <button class="txt-btn" data-close>Hủy</button>
        <h2 id="sh-title">${editing ? "Sửa giao dịch" : "Giao dịch mới"}</h2>
        <button class="txt-btn strong" data-save>Lưu</button>
      </header>
      <div class="sheet-body">
        <div class="seg seg-kind">
          <button type="button" data-kind="in">＋ Thêm tiền</button>
          <button type="button" data-kind="out">－ Chi tiêu</button>
        </div>
        <label class="amount">
          <span class="amount-sign" id="e-sign"></span>
          <input id="e-amount" class="money" inputmode="numeric" autocomplete="off" enterkeyhint="done" placeholder="0" aria-label="Số tiền"
            value="${entry ? num(entry.amount) : ""}">
          <span class="amount-cur">đ</span>
        </label>
        <div class="quick">${quick.map((v) => `<button type="button" data-add="${v}">+${compact(v)}</button>`).join("")}<button type="button" data-add="0" class="clear">Xóa số</button></div>
        <div class="cats" id="e-cats" role="radiogroup" aria-label="Danh mục"></div>
        <label class="field"><span>Ghi chú</span>
          <input id="e-note" maxlength="200" placeholder="VD: ăn trưa, đổ xăng, lương tháng 10…" value="${esc(entry ? entry.note : "")}" enterkeyhint="done"></label>
        <label class="field"><span>Thời gian</span>
          <input id="e-at" type="datetime-local" value="${toLocalInput(entry ? entry.at : Date.now())}"></label>
        <div class="preview" id="e-preview" aria-live="polite"></div>
        <div class="form-err" id="e-err" role="alert"></div>
        <button class="btn btn-primary btn-block" data-save>${editing ? "Lưu thay đổi" : "Lưu giao dịch"}</button>
        ${
          editing
            ? `<button class="btn btn-block btn-ghost-danger" data-delete>Xóa giao dịch này</button>
               <p class="meta">Nhập bởi ${esc(entry.by || "không rõ")}</p>`
            : ""
        }
      </div>
    </section>`;
  document.body.classList.add("locked");

  const root = $sheet;
  const amountEl = root.querySelector("#e-amount");
  const atEl = root.querySelector("#e-at");

  const amount = () => parseAmount(amountEl.value);

  const paintKind = () => {
    for (const b of root.querySelectorAll("[data-kind]")) {
      b.classList.toggle("on", b.dataset.kind === st.kind);
      b.setAttribute("aria-pressed", b.dataset.kind === st.kind);
    }
    root.querySelector(".amount").className = "amount " + st.kind;
    root.querySelector("#e-sign").textContent = st.kind === "in" ? "+" : "−";
    const cats = R.CATS[st.kind];
    if (!cats.some((c) => c.key === st.cat)) st.cat = "";
    root.querySelector("#e-cats").innerHTML = cats
      .map(
        (c) =>
          `<button type="button" role="radio" aria-checked="${st.cat === c.key}" class="chip ${st.cat === c.key ? "on" : ""}" data-cat="${c.key}"><span aria-hidden="true">${c.icon}</span> ${c.name}</button>`
      )
      .join("");
  };

  const paintPreview = () => {
    const a = amount();
    const limit = store.wallet.limit;
    const old = entry ? (entry.kind === "in" ? entry.amount : -entry.amount) : 0;
    const eff = st.kind === "in" ? a : -a;
    const after = store.balance() - old + eff;
    let html = `<div class="pv-row"><span>Số dư sau giao dịch</span><b class="${after < 0 ? "neg" : ""}">${money(after)}</b></div>`;
    if (st.kind === "out" && limit) {
      const at = fromLocalInput(atEl.value);
      const wk = startOfWeek(at);
      const base = R.weekSpent(wk) - (entry && entry.kind === "out" && startOfWeek(entry.at) === wk ? entry.amount : 0);
      const total = base + a;
      const lvl = R.limitLevel(total, limit);
      const thisWeek = wk === startOfWeek(Date.now());
      html += `<div class="pv-row"><span>Chi ${thisWeek ? "tuần này" : "tuần " + weekLabel(wk)}</span><b>${money(total)} / ${money(limit)}</b></div>`;
      html += `<div class="meter thin lvl-${lvl || "ok"}"><span style="width:${Math.min(100, (total / limit) * 100)}%"></span></div>`;
      if (lvl === "over" && a > 0)
        html += `<div class="pv-warn crit"><b aria-hidden="true">⚠</b> ${base > limit ? "Tuần này đã vượt hạn mức" : "Khoản này làm tuần vượt hạn mức"} — vượt ${money(total - limit)}</div>`;
      else if (lvl === "near" && a > 0) html += `<div class="pv-warn warn"><b aria-hidden="true">!</b> Sắp chạm hạn mức — còn ${money(limit - total)}</div>`;
    }
    root.querySelector("#e-preview").innerHTML = html;
  };

  const save = () => {
    const a = amount();
    const err = root.querySelector("#e-err");
    if (!validAmount(a)) {
      err.textContent = a ? "Số tiền quá lớn." : "Nhập số tiền trước đã.";
      amountEl.focus();
      return;
    }
    const data = {
      kind: st.kind,
      amount: a,
      cat: st.cat || "khac",
      note: root.querySelector("#e-note").value,
      at: fromLocalInput(atEl.value),
    };
    if (editing) store.update(entry.id, data);
    else store.add(data);
    closeSheet();
    toast(editing ? "Đã lưu thay đổi" : `Đã lưu: ${st.kind === "in" ? "+" : "−"}${money(a)}`);
  };

  root.querySelector(".sheet").addEventListener("click", (ev) => {
    const t = ev.target.closest("button");
    if (!t) return;
    if (t.dataset.kind) {
      st.kind = t.dataset.kind;
      paintKind();
      paintPreview();
    } else if (t.dataset.cat) {
      st.cat = st.cat === t.dataset.cat ? "" : t.dataset.cat;
      paintKind();
    } else if (t.dataset.add !== undefined) {
      const v = Number(t.dataset.add);
      const next = v ? Math.min(amount() + v, 100000000000) : 0;
      amountEl.value = next ? num(next) : "";
      paintPreview();
    } else if (t.hasAttribute("data-save")) {
      save();
    } else if (t.hasAttribute("data-delete")) {
      confirmBox({
        title: "Xóa giao dịch?",
        text: `${esc(entry.note || R.catInfo(entry.kind, entry.cat).name)}: ${entry.kind === "in" ? "+" : "−"}${money(entry.amount)}. Giao dịch cũng bị xóa trên iPhone kia.`,
        ok: "Xóa",
        danger: true,
      }).then((yes) => {
        if (!yes) return;
        store.remove(entry.id);
        closeSheet();
        toast("Đã xóa giao dịch", { label: "Hoàn tác", fn: () => store.update(entry.id, { del: false }) });
      });
    } else if (t.hasAttribute("data-close")) {
      closeSheet();
    }
  });
  root.querySelector(".sheet-bg").addEventListener("click", closeSheet);
  amountEl.addEventListener("input", paintPreview);
  atEl.addEventListener("change", paintPreview);
  for (const inp of root.querySelectorAll("#e-amount, #e-note")) {
    inp.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        inp.blur();
      }
    });
  }

  paintKind();
  paintPreview();
  if (!editing) amountEl.focus(); // gọi ngay trong lúc chạm nút để iPhone bật bàn phím số
}

// ---------- Cảnh báo vượt hạn mức tuần ----------

function openAlert(wk) {
  const S = R.summarize(wk, addDays(wk, 7));
  const limit = store.wallet.limit;
  const cats = S.byCat.slice(0, 3);
  $modal.innerHTML = `
    <div class="modal-bg"></div>
    <section class="modal alert" role="alertdialog" aria-modal="true" aria-labelledby="al-title" aria-describedby="al-desc">
      <div class="al-icon" aria-hidden="true">⚠</div>
      <h2 id="al-title">Vượt hạn mức chi tiêu tuần</h2>
      <p id="al-desc">Tuần ${weekLabel(wk)} đã chi <b>${money(S.out)}</b>, vượt <b class="crit">${money(S.out - limit)}</b> so với hạn mức ${money(limit)}.</p>
      <div class="meter lvl-over"><span style="width:100%"></span></div>
      ${
        cats.length
          ? `<h3>Chi nhiều nhất</h3><ul class="al-list">${cats
              .map((c) => `<li><span><span aria-hidden="true">${c.icon}</span> ${esc(c.name)}</span><b>${money(c.amount)}</b></li>`)
              .join("")}</ul>`
          : ""
      }
      ${
        S.top.length
          ? `<h3>Khoản lớn nhất</h3><ul class="al-list">${S.top
              .slice(0, 3)
              .map(
                (e) =>
                  `<li><span>${esc(e.note || R.catInfo(e.kind, e.cat).name)}<small>${[e.by, `${WEEKDAYS_SHORT[new Date(e.at).getDay()]} ${dm(e.at)}`].filter(Boolean).map(esc).join(" · ")}</small></span><b>${money(e.amount)}</b></li>`
              )
              .join("")}</ul>`
          : ""
      }
      <div class="modal-btns">
        <button class="btn" data-al="report">Xem báo cáo tuần</button>
        <button class="btn btn-primary" data-al="ok">Đã hiểu</button>
      </div>
    </section>`;
  const close = () => ($modal.innerHTML = "");
  $modal.querySelector('[data-al="ok"]').addEventListener("click", close);
  $modal.querySelector(".modal-bg").addEventListener("click", close);
  $modal.querySelector('[data-al="report"]').addEventListener("click", () => {
    close();
    ui.rep.mode = "week";
    ui.rep.anchor = wk;
    go("report");
  });
  $modal.querySelector('[data-al="ok"]').focus();
}

/** Mỗi tuần, trên mỗi máy: báo một lần khi chạm 80% hạn mức, một lần khi vượt. */
function checkWeekAlert() {
  if (!store.hasWallet || ui.route === "welcome" || ui.route === "reveal") return;
  const limit = store.wallet.limit;
  const wk = startOfWeek(Date.now());
  const spent = R.weekSpent(wk);
  const level = R.limitLevel(spent, limit);
  const shown = store.alertShown(wk);
  if (level === "over") {
    if (shown !== "over") {
      store.markAlert(wk, "over");
      openAlert(wk);
    }
  } else if (level === "near") {
    if (!shown) {
      store.markAlert(wk, "near");
      toast(`Tuần này đã chi ${money(spent)}, còn ${money(limit - spent)} là chạm hạn mức.`);
    } else if (shown === "over") store.markAlert(wk, "near");
  } else if (shown) store.markAlert(wk, "");
}

// ---------- Sự kiện chung ----------

document.addEventListener("click", async (ev) => {
  const t = ev.target.closest("[data-action],[data-edit],[data-filter],[data-mode],[data-wtab],[data-week]");
  if (!t || !document.body.contains(t)) return;
  if ($sheet.contains(t) || $modal.contains(t)) return;

  if (t.dataset.edit) {
    const e = store.get(t.dataset.edit);
    if (e && !e.del) openEntrySheet(e.kind, e);
    return;
  }
  if (t.dataset.filter) {
    ui.hist.filter = t.dataset.filter;
    ui.hist.limit = 120;
    for (const b of document.querySelectorAll("#hist-seg button")) b.classList.toggle("on", b === t);
    renderHistList();
    return;
  }
  if (t.dataset.mode) {
    ui.rep.mode = t.dataset.mode;
    ui.rep.anchor = Date.now();
    render();
    return;
  }
  if (t.dataset.wtab) {
    ui.welcomeTab = t.dataset.wtab;
    render();
    return;
  }
  if (t.dataset.week) {
    ui.rep.mode = "week";
    ui.rep.anchor = Number(t.dataset.week);
    render(true);
    return;
  }

  switch (t.dataset.action) {
    case "add-in":
      return openEntrySheet("in");
    case "add-out":
      return openEntrySheet("out");
    case "sync":
      if (sync.status !== "ok" && sync.status !== "busy") toast(syncDetail());
      return sync.syncNow();
    case "more":
      ui.hist.limit += 200;
      return renderHistList();
    case "report-week":
      ui.rep.mode = "week";
      ui.rep.anchor = Date.now();
      return go("report");
    case "report-month":
      ui.rep.mode = "month";
      ui.rep.anchor = Date.now();
      return go("report");
    case "prev":
      ui.rep.anchor = ui.rep.mode === "week" ? addDays(ui.rep.anchor, -7) : addMonths(ui.rep.anchor, -1);
      return render();
    case "next":
      ui.rep.anchor = ui.rep.mode === "week" ? addDays(ui.rep.anchor, 7) : addMonths(ui.rep.anchor, 1);
      return render();
    case "copy-code":
      if (await copyText(store.state.code)) toast("Đã sao chép mã sổ");
      else toast("Không sao chép được, hãy chép tay: " + store.state.code);
      return;
    case "share-code":
      return shareCode(store.state.code);
    case "start":
      ui.reveal = false;
      go("home");
      setTimeout(checkWeekAlert, 300);
      return;
    case "save-wallet": {
      const name = document.getElementById("s-name").value.trim() || "Sổ tiết kiệm";
      const initial = moneyVal("#s-initial");
      const limit = moneyVal("#s-limit");
      if (initial > 100000000000 || limit > 100000000000) return toast("Số tiền quá lớn");
      const w = store.wallet;
      if (name === w.name && initial === w.initial && limit === w.limit) return toast("Không có gì thay đổi");
      store.setWallet({ name, initial, limit });
      return toast("Đã lưu cài đặt sổ");
    }
    case "save-me": {
      const name = document.getElementById("s-me").value.trim();
      if (!name) return toast("Nhập tên của bạn");
      store.setMe(name);
      return toast("Đã lưu tên");
    }
    case "export":
      return exportCsv();
    case "notify-on":
      // Phải gọi ngay trong lúc chạm nút: iPhone chỉ cho xin quyền thông báo khi đó.
      t.disabled = true;
      return push
        .enable()
        .then(() => toast("Đã bật thông báo trên máy này 🔔"))
        .catch((e) => toast(e.message || "Không bật được thông báo"))
        .finally(() => render());
    case "notify-off":
      return push
        .disable()
        .then(() => toast("Đã tắt thông báo trên máy này"))
        .finally(() => render());
    case "notify-test":
      t.disabled = true;
      return push
        .test()
        .then(() => toast("Đã gửi thử, thông báo sẽ hiện sau vài giây"))
        .catch((e) => toast(e.message))
        .finally(() => (t.disabled = false));
    case "notify-hint-close":
      return store.setNotify({ hint: false });
    case "leave": {
      const pend = store.pendingCount;
      const yes = await confirmBox({
        title: "Rời sổ trên máy này?",
        text: `Dữ liệu trên iPhone này sẽ bị xóa. Sổ vẫn còn trên máy chủ: nhập lại mã <b>${esc(store.state.code)}</b> là có lại (hãy lưu mã trước).${
          pend ? `<br><b class="crit">Còn ${pend} thay đổi chưa gửi lên máy chủ sẽ bị mất.</b>` : ""
        }`,
        ok: "Rời sổ",
        danger: true,
      });
      if (!yes) return;
      await push.disable().catch(() => {});
      store.leave();
      ui.welcomeTab = "join";
      go("home");
      return;
    }
  }
});

document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") {
    if ($modal.firstChild) $modal.innerHTML = "";
    else closeSheet();
  }
  if ((ev.key === "Enter" || ev.key === " ") && ev.target.matches && ev.target.matches('[role="button"][data-action]')) {
    ev.preventDefault();
    ev.target.click();
  }
});

function exportCsv() {
  const cell = (v, text = false) => {
    let s = String(v ?? "");
    if (text && /^[=+\-@]/.test(s)) s = "'" + s; // tránh Excel hiểu nhầm là công thức
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = [["Ngày", "Giờ", "Loại", "Số tiền", "Danh mục", "Ghi chú", "Người nhập", "Số dư sau"]];
  rows.push(["", "", "Số tiền ban đầu", store.wallet.initial, "", "", "", store.wallet.initial].map((v) => cell(v)));
  for (const e of store.list()) {
    rows.push([
      cell(dmy(e.at)),
      cell(hm(e.at)),
      cell(e.kind === "in" ? "Thêm tiền" : "Chi tiêu"),
      cell(e.kind === "in" ? e.amount : -e.amount),
      cell(R.catInfo(e.kind, e.cat).name),
      cell(e.note, true),
      cell(e.by, true),
      cell(store.balanceAfter(e.id)),
    ]);
  }
  const csv = "\uFEFF" + rows.map((r) => r.join(",")).join("\r\n");
  const d = new Date();
  const name = `tiet-kiem-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}.csv`;
  const file = new File([csv], name, { type: "text/csv" });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    navigator.share({ files: [file], title: "Sổ tiết kiệm" }).catch(() => {});
    return;
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(file);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

// ---------- Khởi động ----------

store.onChange((kind) => {
  if (kind === "wallet" && !store.hasWallet) {
    route();
    return;
  }
  if (ui.route === "welcome") return;
  scheduleRender();
  if (kind === "entry" || kind === "remote" || kind === "wallet") setTimeout(checkWeekAlert, 50);
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

document.addEventListener("change", (ev) => {
  const pref = ev.target.dataset && ev.target.dataset.pref;
  if (pref) push.setPrefs({ [pref]: ev.target.checked }).catch((e) => toast(e.message || "Không lưu được lựa chọn"));
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") push.clearBadge();
});

route();
sync.start();
setTimeout(checkWeekAlert, 600);
push.clearBadge();
push.refresh();
