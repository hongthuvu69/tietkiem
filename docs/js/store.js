// Dữ liệu trên máy: sổ, giao dịch và hàng chờ đẩy lên máy chủ, lưu trong localStorage.
// Mọi thay đổi ghi vào máy trước (dùng được cả khi mất mạng), rồi sync.js mới đẩy lên.
import { uuid } from "./util.js";

const KEY = "tietkiem.v1";
export const MAX_AMOUNT = 100000000000; // 100 tỷ, khớp ràng buộc trong schema.sql
export const DEFAULT_LIMIT = 1500000;

function blank() {
  return {
    v: 1,
    code: "", // mã sổ, rỗng = chưa vào sổ nào
    created: true, // false = sổ vừa tạo trên máy, chưa tạo được trên máy chủ
    me: { id: uuid(), name: "" },
    wallet: { name: "Sổ tiết kiệm", initial: 0, limit: DEFAULT_LIMIT, upd: 0 },
    walletDirty: false,
    entries: {}, // id → giao dịch
    outbox: {}, // id → upd của bản đang chờ đẩy
    rev: 0, // rev lớn nhất đã kéo về
    lastSync: 0,
    alerts: {}, // tuần (ms của Thứ Hai) → "near" | "over": đã cảnh báo trên máy này
    notify: { on: false, key: "", prefs: { entries: true, alerts: true, weekly: true }, hint: true }, // thông báo đẩy trên máy này
  };
}

function load() {
  const base = blank();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return base;
    const s = JSON.parse(raw);
    return {
      ...base,
      ...s,
      me: { ...base.me, ...s.me },
      wallet: { ...base.wallet, ...s.wallet },
      notify: { ...base.notify, ...s.notify, prefs: { ...base.notify.prefs, ...(s.notify && s.notify.prefs) } },
    };
  } catch {
    return base;
  }
}

const listeners = new Set();
let s = load();
let version = 0;
let cache = { v: -1, list: [], after: new Map() };

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch (e) {
    console.warn("Không lưu được dữ liệu trên máy", e);
  }
}

function emit(kind, persist = true) {
  version++;
  if (persist) save();
  for (const fn of listeners) fn(kind);
}

function clean(e) {
  return {
    id: String(e.id),
    kind: e.kind === "in" ? "in" : "out",
    amount: Math.round(Number(e.amount) || 0),
    note: String(e.note || "").trim().slice(0, 200),
    cat: String(e.cat || "").slice(0, 30),
    by: String(e.by || "").slice(0, 30),
    at: Number(e.at) || Date.now(),
    upd: Number(e.upd) || 0,
    del: !!e.del,
  };
}

function same(a, b) {
  return (
    a.kind === b.kind &&
    a.amount === b.amount &&
    a.note === b.note &&
    a.cat === b.cat &&
    a.by === b.by &&
    a.at === b.at &&
    a.upd === b.upd &&
    a.del === b.del
  );
}

export function validAmount(n) {
  return Number.isInteger(n) && n > 0 && n <= MAX_AMOUNT;
}

export const store = {
  get state() {
    return s;
  },
  get hasWallet() {
    return !!s.code;
  },
  get wallet() {
    return s.wallet;
  },
  get me() {
    return s.me;
  },
  get version() {
    return version;
  },

  onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  // ---------- Vào / rời sổ ----------

  /** Sổ mới tạo trên máy này; sync.js sẽ tạo nó trên máy chủ. */
  createLocal(code, wallet, myName) {
    const me = { ...s.me, name: myName };
    const notify = s.notify;
    s = blank();
    s.me = me;
    s.notify = notify;
    s.code = code;
    s.created = false;
    s.wallet = { ...s.wallet, ...wallet, upd: Date.now() };
    emit("wallet");
  },

  /** Tham gia sổ đã có (dữ liệu kéo về ngay sau đó bằng applyPull). */
  joinLocal(code, myName) {
    const me = { ...s.me, name: myName };
    const notify = s.notify;
    s = blank();
    s.me = me;
    s.notify = notify;
    s.code = code;
    emit("wallet");
  },

  /** Rời sổ trên máy này. Dữ liệu trên máy chủ vẫn còn, nhập lại mã là có lại. */
  leave() {
    const me = s.me;
    const notify = { ...s.notify, on: false };
    s = blank();
    s.me = me;
    s.notify = notify;
    emit("wallet");
  },

  get notify() {
    return s.notify;
  },

  setNotify(patch) {
    s.notify = { ...s.notify, ...patch, prefs: { ...s.notify.prefs, ...(patch.prefs || {}) } };
    emit("notify");
  },

  setMe(name) {
    s.me.name = String(name || "").trim().slice(0, 30);
    emit("me");
  },

  setWallet(patch) {
    s.wallet = { ...s.wallet, ...patch, upd: Math.max(Date.now(), s.wallet.upd + 1) };
    s.walletDirty = true;
    emit("wallet");
  },

  // ---------- Giao dịch ----------

  add({ kind, amount, note, cat, at }) {
    const e = clean({ id: uuid(), kind, amount, note, cat, at, by: s.me.name, upd: Date.now() });
    s.entries[e.id] = e;
    s.outbox[e.id] = e.upd;
    emit("entry");
    return e;
  },

  update(id, patch) {
    const old = s.entries[id];
    if (!old) return null;
    const e = clean({ ...old, ...patch, id, upd: Math.max(Date.now(), old.upd + 1) });
    s.entries[id] = e;
    s.outbox[id] = e.upd;
    emit("entry");
    return e;
  },

  remove(id) {
    return this.update(id, { del: true });
  },

  get(id) {
    return s.entries[id] || null;
  },

  /** Giao dịch còn hiệu lực, xếp theo thời gian tăng dần. */
  list() {
    if (cache.v !== version) {
      const list = Object.values(s.entries)
        .filter((e) => !e.del)
        .sort((a, b) => a.at - b.at || a.upd - b.upd || (a.id < b.id ? -1 : 1));
      // Số dư ngay sau mỗi giao dịch, để lịch sử hiện "còn lại".
      const after = new Map();
      let bal = s.wallet.initial;
      for (const e of list) {
        bal += e.kind === "in" ? e.amount : -e.amount;
        after.set(e.id, bal);
      }
      cache = { v: version, list, after };
    }
    return cache.list;
  },

  balanceAfter(id) {
    this.list();
    return cache.after.get(id);
  },

  balance() {
    let bal = s.wallet.initial;
    for (const e of this.list()) bal += e.kind === "in" ? e.amount : -e.amount;
    return bal;
  },

  // ---------- Cảnh báo đã hiện trên máy này ----------

  alertShown(week) {
    return s.alerts[week] || "";
  },

  markAlert(week, level) {
    s.alerts[week] = level;
    // Chỉ giữ 20 tuần gần nhất.
    const keys = Object.keys(s.alerts).sort((a, b) => b - a);
    for (const k of keys.slice(20)) delete s.alerts[k];
    save();
  },

  // ---------- Dùng cho đồng bộ ----------

  get pendingCount() {
    return Object.keys(s.outbox).length + (s.walletDirty ? 1 : 0);
  },

  /** Những gì cần đẩy lên: tối đa `max` giao dịch và cài đặt sổ nếu vừa sửa. */
  pending(max = 200) {
    const entries = [];
    for (const id of Object.keys(s.outbox)) {
      const e = s.entries[id];
      if (!e) {
        delete s.outbox[id];
        continue;
      }
      entries.push({ ...e });
      if (entries.length >= max) break;
    }
    return { entries, wallet: s.walletDirty ? { ...s.wallet } : null };
  },

  /** Máy chủ đã nhận: bỏ khỏi hàng chờ, trừ dòng vừa bị sửa tiếp trong lúc đang đẩy. */
  ackPush(sent) {
    for (const e of sent.entries) if (s.outbox[e.id] === e.upd) delete s.outbox[e.id];
    if (sent.wallet && s.wallet.upd === sent.wallet.upd) s.walletDirty = false;
    save();
  },

  markCreated() {
    s.created = true;
    save();
  },

  /** Gộp dữ liệu kéo về. Trả về true nếu có gì thay đổi trên máy. */
  applyPull(data) {
    let changed = false;
    const w = data.wallet;
    if (w) {
      const remote = {
        name: String(w.name || ""),
        initial: Number(w.initial) || 0,
        limit: Number(w.limit) || 0,
        upd: Number(w.upd) || 0,
      };
      if (!(s.walletDirty && s.wallet.upd > remote.upd)) {
        const cur = s.wallet;
        if (cur.name !== remote.name || cur.initial !== remote.initial || cur.limit !== remote.limit || cur.upd !== remote.upd) {
          s.wallet = remote;
          changed = true;
        }
        s.walletDirty = false;
      }
    }
    for (const raw of data.entries || []) {
      const e = clean(raw);
      const local = s.entries[e.id];
      if (local && s.outbox[e.id] && local.upd > e.upd) continue; // bản trên máy mới hơn, đang chờ đẩy
      if (!local || !same(local, e)) {
        s.entries[e.id] = e;
        changed = true;
      }
      if (s.outbox[e.id] && s.outbox[e.id] <= e.upd) delete s.outbox[e.id];
    }
    if (Number(data.rev) > s.rev) s.rev = Number(data.rev);
    if (changed) emit("remote");
    else save();
    return changed;
  },

  setLastSync(ts) {
    s.lastSync = ts;
    save();
  },
};

// Hai tab cùng mở trên một trình duyệt: tab kia sửa thì tab này đọc lại.
window.addEventListener("storage", (ev) => {
  if (ev.key !== KEY) return;
  s = load();
  emit("remote", false);
});
