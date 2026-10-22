// Biểu đồ cột SVG tự vẽ (không cần thư viện), có tooltip khi chạm hoặc di chuột.
// Màu lấy từ biến CSS (--c-out, --c-in, --crit…) nên tự đổi theo chế độ sáng/tối.
import { compact } from "./util.js";

const NS = "http://www.w3.org/2000/svg";

function svgEl(tag, attrs, parent) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, v);
  if (parent) parent.appendChild(n);
  return n;
}

function niceStep(raw) {
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}

/** Cột bo tròn 4px ở đầu, vuông ở chân. */
function colPath(x, y, w, h) {
  const r = Math.min(4, w / 2, h);
  const b = y + h;
  return `M${x},${b}V${y + r}A${r},${r} 0 0 1 ${x + r},${y}H${x + w - r}A${r},${r} 0 0 1 ${x + w},${y + r}V${b}Z`;
}

// Chỉ một tooltip hiện tại một thời điểm; chạm ra ngoài biểu đồ thì ẩn.
let current = null;
document.addEventListener("pointerdown", (ev) => {
  if (current && !current.host.contains(ev.target)) {
    current.hide();
    current = null;
  }
});

/**
 * Vẽ biểu đồ cột vào host.
 * opts.rows:   [{ label, values: {out, in}, title, lines: [{key, name, text}], strong, over }]
 * opts.series: [{ key: "out" | "in" }]
 * opts.limit:  vẽ đường hạn mức (tùy chọn)
 * opts.labelEvery: chỉ ghi nhãn trục X mỗi k cột (mặc định 1)
 * opts.onPick: bấm vào cột → onPick(i)
 */
export function columnChart(host, opts) {
  const { rows, series } = opts;
  host.textContent = "";
  host.classList.add("chart");
  const W = Math.max(240, Math.round(host.clientWidth || 320));
  const H = opts.height || 176;
  const padL = 40;
  const padR = 6;
  const padT = 24;
  const axisH = 24;
  const plotW = W - padL - padR;
  const plotH = H - padT - axisH;
  const n = rows.length;
  const slot = plotW / n;
  const cx = (i) => padL + i * slot + slot / 2;

  let maxVal = opts.limit || 0;
  for (const r of rows) for (const s of series) maxVal = Math.max(maxVal, r.values[s.key] || 0);
  if (maxVal <= 0) maxVal = 100000;
  const step = niceStep(maxVal / 3);
  const top = Math.ceil((maxVal * 1.04) / step) * step;
  const y = (v) => padT + plotH - (v / top) * plotH;

  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "img", "aria-label": opts.label || "Biểu đồ" });
  const hl = svgEl("rect", { class: "hl", x: 0, y: padT - 6, width: slot, height: plotH + 6, rx: 8 }, svg);

  // Lưới ngang và nhãn trục Y
  for (let t = 0; t <= top + 1e-6; t += step) {
    const yy = Math.round(y(t)) + 0.5;
    svgEl("line", { x1: padL, x2: W - padR, y1: yy, y2: yy, class: t === 0 ? "axis" : "grid" }, svg);
    svgEl("text", { x: padL - 6, y: yy + 4, class: "tick", "text-anchor": "end" }, svg).textContent = t === 0 ? "0" : compact(t);
  }

  // Cột (nhiều chuỗi thì đứng cạnh nhau, cách 2px)
  const multi = series.length > 1;
  const bw = multi ? Math.max(3, Math.min(12, (slot * 0.74 - 2) / 2)) : Math.max(3, Math.min(24, slot * 0.62));
  const groupW = bw * series.length + 2 * (series.length - 1);
  let maxPos = null;
  rows.forEach((r, i) => {
    const gx = cx(i) - groupW / 2;
    series.forEach((s, j) => {
      const v = r.values[s.key] || 0;
      if (v <= 0) return;
      const x = gx + j * (bw + 2);
      const h = Math.max(1.5, padT + plotH - y(v));
      const cls = `bar s-${s.key}${r.over && s.key === "out" ? " over" : ""}`;
      svgEl("path", { d: colPath(x, padT + plotH - h, bw, h), class: cls }, svg);
      if (!maxPos || v > maxPos.v) maxPos = { v, x: x + bw / 2, y: padT + plotH - h, over: r.over };
    });
    if (r.over) {
      svgEl("text", { x: cx(i), y: y(r.values.out || 0) - 6, class: "over-mark", "text-anchor": "middle" }, svg).textContent = "⚠";
    }
  });

  // Nhãn giá trị: chỉ ghi ở cột cao nhất
  if (opts.valueLabel !== false && maxPos && !maxPos.over) {
    svgEl("text", { x: maxPos.x, y: maxPos.y - 6, class: "vlabel", "text-anchor": "middle" }, svg).textContent = compact(maxPos.v);
  }

  // Đường hạn mức; nhãn đặt ở đầu trái để không đè lên cột tuần hiện tại (ở cuối phải).
  if (opts.limit) {
    const yy = Math.round(y(opts.limit)) + 0.5;
    svgEl("line", { x1: padL, x2: W - padR, y1: yy, y2: yy, class: "limit" }, svg);
    svgEl("text", { x: padL + 4, y: yy - 5, class: "limit-label", "text-anchor": "start" }, svg).textContent =
      opts.limitLabel || `Hạn mức ${compact(opts.limit)}`;
  }

  // Nhãn trục X: tính từ cột cuối ngược lại, thưa ra nếu màn hình hẹp không đủ chỗ.
  // Cột đang chọn (strong) luôn có nhãn, bỏ nhãn hàng xóm quá gần nó.
  const labelW = Math.max(...rows.map((r) => String(r.label).length * 6.3)) + 6;
  const every = Math.max(opts.labelEvery || 1, Math.ceil(labelW / slot));
  const shown = new Set();
  rows.forEach((r, i) => (n - 1 - i) % every === 0 && shown.add(i));
  const s = rows.findIndex((r) => r.strong);
  if (s >= 0 && !shown.has(s)) {
    for (const j of [...shown]) if (Math.abs(j - s) < every) shown.delete(j);
    shown.add(s);
  }
  rows.forEach((r, i) => {
    if (!shown.has(i)) return;
    svgEl("text", { x: cx(i), y: H - 7, class: "xl" + (r.strong ? " strong" : ""), "text-anchor": "middle" }, svg).textContent = r.label;
  });

  // Tooltip + vùng chạm (rộng cả ô, cao cả cột lẫn nhãn — dễ trúng hơn bản thân cột)
  const tip = document.createElement("div");
  tip.className = "tip";
  tip.hidden = true;
  let active = -1;
  const ctl = {
    host,
    hide() {
      active = -1;
      svg.classList.remove("act");
      tip.hidden = true;
    },
  };
  const show = (i) => {
    if (current && current !== ctl) current.hide();
    current = ctl;
    if (active === i) return;
    active = i;
    const r = rows[i];
    hl.setAttribute("x", padL + i * slot);
    svg.classList.add("act");
    tip.textContent = "";
    const head = document.createElement("div");
    head.className = "tip-title";
    head.textContent = r.title;
    tip.appendChild(head);
    for (const l of r.lines || []) {
      const row = document.createElement("div");
      row.className = "tip-row";
      const key = document.createElement("span");
      key.className = `tip-key k-${l.key || "none"}`;
      const val = document.createElement("b");
      val.textContent = l.text;
      const name = document.createElement("span");
      name.textContent = l.name;
      row.append(key, val, name);
      tip.appendChild(row);
    }
    tip.hidden = false;
    const tw = tip.offsetWidth;
    tip.style.left = Math.min(Math.max(cx(i) - tw / 2, 0), W - tw) + "px";
  };

  rows.forEach((r, i) => {
    const hit = svgEl("rect", { x: padL + i * slot, y: 0, width: slot, height: H, class: "hit", tabindex: 0 }, svg);
    hit.setAttribute("aria-label", [r.title, ...(r.lines || []).map((l) => `${l.name} ${l.text}`)].join(", "));
    if (opts.onPick) hit.setAttribute("role", "button");
    hit.addEventListener("pointerenter", () => show(i));
    hit.addEventListener("pointerdown", () => show(i));
    hit.addEventListener("focus", () => show(i));
    hit.addEventListener("blur", () => ctl.hide());
    if (opts.onPick) {
      hit.addEventListener("click", () => opts.onPick(i));
      hit.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          opts.onPick(i);
        }
      });
    }
  });
  svg.addEventListener("pointerleave", (ev) => {
    if (ev.pointerType === "mouse") ctl.hide();
  });

  host.append(svg, tip);
}
