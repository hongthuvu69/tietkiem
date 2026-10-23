// Thông báo đẩy (Web Push): đăng ký máy này với máy chủ để nhận thông báo kể cả khi app đang tắt.
// iPhone cần iOS 16.4+ và app phải mở từ màn hình chính. Máy chủ gửi bằng Edge Function tk-notify.
import { NOTIFY_URL } from "./config.js";
import { store } from "./store.js";
import { sync } from "./sync.js";

const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const standalone = navigator.standalone === true || matchMedia("(display-mode: standalone)").matches;

function b64uToBytes(s) {
  const b = s.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(b + "===".slice((b.length + 3) % 4)), (c) => c.charCodeAt(0));
}

async function serverKey() {
  let res;
  try {
    res = await fetch(NOTIFY_URL, { cache: "no-store" });
  } catch {
    throw new Error("Không kết nối được máy chủ thông báo (kiểm tra mạng).");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.publicKey) {
    throw new Error(res.status === 404 ? "Máy chủ chưa cài hàm gửi thông báo (tk-notify)." : data.error || `Lỗi máy chủ thông báo (HTTP ${res.status}).`);
  }
  return data.publicKey;
}

async function registration() {
  return navigator.serviceWorker.ready;
}

export const push = {
  get supported() {
    return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  },

  /** "install" (iPhone chưa mở từ màn hình chính) | "unsupported" | "denied" | "on" | "off" */
  async status() {
    if (!this.supported) return isIOS && !standalone ? "install" : "unsupported";
    if (isIOS && !standalone) return "install";
    if (Notification.permission === "denied") return "denied";
    if (Notification.permission !== "granted" || !store.notify.on) return "off";
    const sub = await (await registration()).pushManager.getSubscription();
    return sub ? "on" : "off";
  },

  /** Gọi ngay trong lúc người dùng chạm nút (iPhone chỉ cho xin quyền khi đó). */
  async enable() {
    const perm = await Notification.requestPermission();
    if (perm !== "granted") throw new Error(perm === "denied" ? "Bạn đã chặn thông báo cho app này." : "Chưa cho phép thông báo.");
    const key = await serverKey();
    const reg = await registration();
    let sub = await reg.pushManager.getSubscription();
    if (sub && store.notify.key !== key) {
      await sub.unsubscribe().catch(() => {});
      sub = null;
    }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(key) });
    await this.register(sub);
    store.setNotify({ on: true, key, hint: false });
  },

  /** Báo cho máy chủ biết máy này nhận thông báo của sổ hiện tại (kèm lựa chọn loại thông báo). */
  async register(sub) {
    const j = sub.toJSON();
    await sync.rpc("tk_subscribe", {
      p_code: store.state.code,
      p_sub: { endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth, dev: store.me.id, by: store.me.name, prefs: store.notify.prefs },
    });
  },

  async disable() {
    const reg = await registration();
    const sub = await reg.pushManager.getSubscription();
    store.setNotify({ on: false });
    if (!sub) return;
    if (store.state.code) await sync.rpc("tk_unsubscribe", { p_code: store.state.code, p_endpoint: sub.endpoint }).catch(() => {});
    await sub.unsubscribe().catch(() => {});
  },

  async setPrefs(prefs) {
    store.setNotify({ prefs });
    const sub = await (await registration()).pushManager.getSubscription();
    if (sub && store.notify.on) await this.register(sub);
  },

  async test() {
    const sub = await (await registration()).pushManager.getSubscription();
    if (!sub) throw new Error("Máy này chưa bật thông báo.");
    const res = await fetch(NOTIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ test: { code: store.state.code, endpoint: sub.endpoint } }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Gửi thử lỗi (HTTP ${res.status}).`);
    }
  },

  /** Mở app: đăng ký lại (cập nhật sổ, tên, lựa chọn), không hỏi gì người dùng. */
  async refresh() {
    try {
      if (!this.supported || !store.hasWallet || !store.notify.on || Notification.permission !== "granted") return;
      const sub = await (await registration()).pushManager.getSubscription();
      if (sub) await this.register(sub);
      else store.setNotify({ on: false });
    } catch {}
  },

  /** Xóa số đỏ trên biểu tượng app khi đã mở app xem. */
  clearBadge() {
    if (navigator.clearAppBadge) navigator.clearAppBadge().catch(() => {});
    if (navigator.serviceWorker && navigator.serviceWorker.controller) navigator.serviceWorker.controller.postMessage("clear-badge");
  },
};
