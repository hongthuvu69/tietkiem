// Đồng bộ với Supabase qua 3 hàm RPC trong supabase/schema.sql.
// Mỗi lượt: (tạo sổ nếu chưa có) → đẩy thay đổi trên máy → kéo thay đổi mới (theo rev).
// Có thay đổi trên máy thì đẩy ngay; còn lại cứ 15 giây kéo một lần khi app đang mở.
import { SUPABASE_URL, SUPABASE_KEY } from "./config.js";
import { store } from "./store.js";

export const SYNC_MS = 15000;
const TIMEOUT_MS = 15000;
const listeners = new Set();

const walletWire = (w) => ({ name: w.name, initial: w.initial, limit: w.limit, upd: w.upd });
const entryWire = (e) => ({
  id: e.id,
  kind: e.kind,
  amount: e.amount,
  note: e.note,
  cat: e.cat,
  by: e.by,
  at: e.at,
  upd: e.upd,
  del: e.del,
  dev: store.me.id, // máy gửi thay đổi: máy chủ không báo lại cho chính máy này
});

export const sync = {
  // idle | busy | ok | offline | notfound | setup | error
  status: "idle",
  message: "",
  busy: false,
  again: false,
  timer: 0,
  soonTimer: 0,

  onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  set(status, message = "") {
    this.status = status;
    this.message = message;
    for (const fn of listeners) fn();
  },

  async rpc(name, body) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
        method: "POST",
        headers: { apikey: SUPABASE_KEY, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        cache: "no-store",
        signal: ctrl.signal,
      });
    } catch {
      throw { kind: "offline", message: "Không kết nối được máy chủ" };
    } finally {
      clearTimeout(t);
    }
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {}
    if (!res.ok) {
      const msg = (data && (data.message || data.error)) || "";
      if (msg.includes("TK_NOT_FOUND")) throw { kind: "notfound", message: "Không tìm thấy sổ với mã này" };
      if (msg.includes("TK_EXISTS")) throw { kind: "exists", message: "Mã sổ đã tồn tại" };
      if (res.status === 404 || (data && data.code === "PGRST202"))
        throw { kind: "setup", message: "Máy chủ chưa được cài đặt (chạy supabase/schema.sql)" };
      throw { kind: "error", message: `${msg || "Lỗi máy chủ"} (HTTP ${res.status})` };
    }
    return data;
  },

  /** Kiểm tra mã và kéo toàn bộ sổ về máy này. */
  async join(code, myName) {
    const data = await this.rpc("tk_pull", { p_code: code, p_since: 0 });
    store.joinLocal(code, myName);
    store.applyPull(data);
    store.setLastSync(Date.now());
    this.set("ok");
    if (data.more) this.syncNow();
  },

  async syncNow() {
    if (!store.hasWallet) return;
    if (this.busy) {
      this.again = true;
      return;
    }
    this.busy = true;
    clearTimeout(this.timer);
    clearTimeout(this.soonTimer);
    this.set("busy");
    const code = store.state.code;
    try {
      if (!store.state.created) {
        try {
          await this.rpc("tk_create", { p_code: code, p_wallet: walletWire(store.wallet) });
        } catch (e) {
          // Lần trước đã tạo xong nhưng mất mạng trước khi nhận được trả lời.
          if (e.kind !== "exists") throw e;
        }
        if (store.state.code !== code) return;
        store.markCreated();
      }

      for (let i = 0; i < 25; i++) {
        const p = store.pending(200);
        if (!p.entries.length && !p.wallet) break;
        await this.rpc("tk_push", {
          p_code: code,
          p_entries: p.entries.map(entryWire),
          p_wallet: p.wallet ? walletWire(p.wallet) : null,
        });
        if (store.state.code !== code) return;
        store.ackPush(p);
      }

      for (let i = 0; i < 50; i++) {
        const data = await this.rpc("tk_pull", { p_code: code, p_since: store.state.rev });
        if (store.state.code !== code) return;
        store.applyPull(data);
        if (!data.more) break;
      }

      store.setLastSync(Date.now());
      this.set("ok");
    } catch (e) {
      this.set(e.kind || "error", e.message || String(e));
    } finally {
      this.busy = false;
      if (this.again) {
        this.again = false;
        this.syncNow();
      } else {
        this.schedule();
      }
    }
  },

  /** Lượt kéo kế tiếp sau 15 giây (chỉ khi app đang hiện trên màn hình). */
  schedule() {
    clearTimeout(this.timer);
    if (!store.hasWallet || document.visibilityState !== "visible") return;
    this.timer = setTimeout(() => this.syncNow(), SYNC_MS);
  },

  /** Vừa sửa trên máy: đẩy lên gần như ngay. */
  soon() {
    clearTimeout(this.soonTimer);
    this.soonTimer = setTimeout(() => this.syncNow(), 400);
  },

  start() {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") this.syncNow();
      else clearTimeout(this.timer);
    });
    window.addEventListener("online", () => this.syncNow());
    window.addEventListener("pageshow", (ev) => {
      if (ev.persisted) this.syncNow();
    });
    store.onChange((kind) => {
      if (kind === "entry" || kind === "wallet") this.soon();
    });
    this.syncNow();
  },
};
