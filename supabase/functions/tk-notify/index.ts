// Supabase Edge Function "tk-notify": gửi thông báo đẩy (Web Push) cho app Tiết Kiệm Chung.
//
// - POST {entry, rev, op}  ← trigger trên bảng tk_entries gọi mỗi khi có giao dịch thêm/sửa.
// - POST {weekly: true}    ← lịch pg_cron tối Chủ Nhật (tổng kết tuần).
// - POST {test: {code, endpoint}} ← nút "Gửi thử" trong app.
// - GET                    ← app lấy khóa công khai VAPID để đăng ký nhận thông báo.
//
// Nội dung và người nhận do các hàm SQL tk_notify_plan / tk_weekly_plan quyết định (có chống gửi trùng),
// nên ai gọi hàm này nhiều lần cũng không gây spam. Cặp khóa VAPID tự tạo ở lần chạy đầu và lưu trong
// bảng tk_config. Mã hóa theo RFC 8291 (aes128gcm) và ký VAPID (RFC 8292) bằng WebCrypto, không cần thư viện.

const APP_URL = "https://hongthuvu69.github.io/tietkiem/";
const SUBJECT = "mailto:hongthuvu69@gmail.com"; // Apple yêu cầu mailto: hoặc https:
const enc = new TextEncoder();

export function b64uEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64uDecode(str: string): Uint8Array {
  const s = str.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function concat(...parts: (Uint8Array | number[])[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) {
    out.set(p, i);
    i += p.length;
  }
  return out;
}

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}

/** Mã hóa nội dung cho một máy nhận (RFC 8291). opts chỉ dùng khi kiểm thử với bộ số mẫu của RFC. */
export async function encryptPayload(
  sub: { p256dh: string; auth: string },
  payload: Uint8Array,
  opts: { salt?: Uint8Array; asKeys?: CryptoKeyPair } = {},
): Promise<Uint8Array> {
  const uaPublic = b64uDecode(sub.p256dh);
  const authSecret = b64uDecode(sub.auth);
  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const asKeys =
    opts.asKeys ?? ((await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", asKeys.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, asKeys.privateKey, 256));

  const prkKey = await hmac(authSecret, ecdh);
  const ikm = await hmac(prkKey, concat(enc.encode("WebPush: info"), [0], uaPublic, asPublic, [1]));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(enc.encode("Content-Encoding: aes128gcm"), [0], [1]))).slice(0, 16);
  const nonce = (await hmac(prk, concat(enc.encode("Content-Encoding: nonce"), [0], [1]))).slice(0, 12);

  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, concat(payload, [2])));
  const header = new Uint8Array(21 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, cipher);
}

type VapidKeys = { publicKey: string; privateJwk: JsonWebKey };

export async function newVapidKeys(): Promise<VapidKeys> {
  const kp = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  return { publicKey: b64uEncode(raw), privateJwk: await crypto.subtle.exportKey("jwk", kp.privateKey) };
}

/** Header Authorization kiểu VAPID cho máy chủ đẩy của endpoint. */
export async function vapidAuth(endpoint: string, keys: VapidKeys, subject = SUBJECT): Promise<string> {
  const head = b64uEncode(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64uEncode(
    enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })),
  );
  const key = await crypto.subtle.importKey("jwk", keys.privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${head}.${claims}`)));
  return `vapid t=${head}.${claims}.${b64uEncode(sig)}, k=${keys.publicKey}`;
}

type Sub = { endpoint: string; p256dh: string; auth: string };
type Message = { to: Sub[]; title: string; body: string; tag?: string };

export async function sendPush(sub: Sub, data: unknown, keys: VapidKeys): Promise<number> {
  const body = await encryptPayload(sub, enc.encode(JSON.stringify(data)));
  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      Authorization: await vapidAuth(sub.endpoint, keys),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: "86400",
      Urgency: "high",
    },
    body,
  });
  await res.body?.cancel();
  return res.status;
}

// ---------- Gọi cơ sở dữ liệu bằng quyền service_role (Supabase tự cấp biến môi trường) ----------

function serviceKey(): string {
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  try {
    const keys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}");
    return String(Object.values(keys)[0] || "");
  } catch {
    return "";
  }
}

async function rpc(name: string, args: Record<string, unknown>): Promise<any> {
  const key = serviceKey();
  const headers: Record<string, string> = { apikey: key, "Content-Type": "application/json" };
  if (key.startsWith("eyJ")) headers.Authorization = `Bearer ${key}`;
  const res = await fetch(`${Deno.env.get("SUPABASE_URL")}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers,
    body: JSON.stringify(args),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

async function vapidKeys(): Promise<VapidKeys> {
  let v = await rpc("tk_config_get", { p_key: "vapid" });
  if (!v) v = await rpc("tk_config_init", { p_key: "vapid", p_value: JSON.stringify(await newVapidKeys()) });
  return JSON.parse(v);
}

async function deliver(messages: Message[]): Promise<number> {
  if (!messages.some((m) => m.to.length)) return 0;
  const keys = await vapidKeys();
  let sent = 0;
  for (const m of messages) {
    for (const sub of m.to) {
      try {
        const status = await sendPush(sub, { title: m.title, body: m.body, tag: m.tag, url: APP_URL }, keys);
        if (status === 404 || status === 410) await rpc("tk_drop_sub", { p_endpoint: sub.endpoint });
        else if (status >= 200 && status < 300) sent++;
        else console.warn("push failed", status, sub.endpoint.slice(0, 40));
      } catch (e) {
        console.warn("push error", String(e));
      }
    }
  }
  return sent;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, apikey, authorization, x-client-info",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json" } });

export async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  try {
    if (req.method === "GET") return json({ publicKey: (await vapidKeys()).publicKey });
    const b = await req.json().catch(() => ({}));
    if (b.entry) {
      const plan = await rpc("tk_notify_plan", { p_entry: b.entry, p_rev: b.rev, p_op: b.op || "INSERT" });
      return json({ sent: await deliver(plan.messages) });
    }
    if (b.weekly) {
      const plan = await rpc("tk_weekly_plan", {});
      return json({ sent: await deliver(plan.messages) });
    }
    if (b.test && b.test.code && b.test.endpoint) {
      const sub = await rpc("tk_test_sub", { p_code: b.test.code, p_endpoint: b.test.endpoint });
      if (!sub) return json({ error: "Máy này chưa đăng ký nhận thông báo" }, 404);
      const status = await sendPush(
        sub,
        { title: "Thông báo đã hoạt động ✓", body: "Tiết Kiệm Chung sẽ báo khi có giao dịch mới và khi chi quá hạn mức tuần.", tag: "test", url: APP_URL },
        await vapidKeys(),
      );
      return json({ status }, status >= 200 && status < 300 ? 200 : 502);
    }
    return json({ error: "Yêu cầu không hợp lệ" }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: String(e) }, 500);
  }
}

if (typeof Deno !== "undefined") Deno.serve(handler);
