// 도형 객체와 페이지 배경: 그리기·범위·충돌 판정·이동
// 도형(t:'shape'): kind, c(선 색), w(굵기), fill(채움 색|null), labels(길이·각도 표시), pts[x,y,...], r, rx, ry, a0, a1

let UNITS_PER_CM = 20;              // 논리 좌표 몇 칸이 1cm 인지 (전자칠판 보정 값)
export const setUnitsPerCm = (v) => { if (v > 2 && v < 400) UNITS_PER_CM = v; };
export const unitsPerCm = () => UNITS_PER_CM;

const P = (o, i) => [o.pts[i * 2], o.pts[i * 2 + 1]];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const deg = (r) => r * 180 / Math.PI;

function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
  let t = L ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1]);
}

// 반직선·직선을 페이지 밖까지 늘린 끝점
function extend(a, b, page, both) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1;
  const far = (page.w + page.h) * 2;
  const end = [a[0] + dx / L * far, a[1] + dy / L * far];
  const start = both ? [a[0] - dx / L * far, a[1] - dy / L * far] : a;
  return [start, end];
}

function polyPoints(o) {
  const out = [];
  for (let i = 0; i < o.pts.length / 2; i++) out.push(P(o, i));
  return out;
}

function rectPoints(o) {
  const [a, b] = [P(o, 0), P(o, 1)];
  return [[a[0], a[1]], [b[0], a[1]], [b[0], b[1]], [a[0], b[1]]];
}

function ellipsePoints(o, n = 72) {
  const [c] = [P(o, 0)], out = [];
  const rx = o.kind === 'circle' ? o.r : o.rx, ry = o.kind === 'circle' ? o.r : o.ry;
  for (let i = 0; i < n; i++) { const t = i / n * Math.PI * 2; out.push([c[0] + rx * Math.cos(t), c[1] + ry * Math.sin(t)]); }
  return out;
}

function arcPoints(o, n = 48) {
  const c = P(o, 0), out = [];
  for (let i = 0; i <= n; i++) { const t = o.a0 + (o.a1 - o.a0) * i / n; out.push([c[0] + o.r * Math.cos(t), c[1] + o.r * Math.sin(t)]); }
  return out;
}

// 충돌 판정과 범위 계산용 꺾은선(닫힘 여부)
function outline(o, page) {
  switch (o.kind) {
    case 'segment': case 'arrow': return { pts: [P(o, 0), P(o, 1)], closed: false };
    case 'ray': return { pts: extend(P(o, 0), P(o, 1), page, false), closed: false };
    case 'line': return { pts: extend(P(o, 0), P(o, 1), page, true), closed: false };
    case 'rect': return { pts: rectPoints(o), closed: true };
    case 'polygon': return { pts: polyPoints(o), closed: true };
    case 'circle': case 'ellipse': return { pts: ellipsePoints(o), closed: true };
    case 'arc': return { pts: arcPoints(o), closed: false };
    case 'sector': return { pts: [P(o, 0), ...arcPoints(o), P(o, 0)], closed: true };
    case 'angle': return { pts: [P(o, 1), P(o, 0), P(o, 2)], closed: false };
  }
  return { pts: [], closed: false };
}

export function shapeBBox(o, page = { w: 3200, h: 1800 }) {
  const ol = o.kind === 'ray' || o.kind === 'line' ? { pts: [P(o, 0), P(o, 1)] } : outline(o, page);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of ol.pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const m = o.w / 2 + 4;
  return { x0: x0 - m, y0: y0 - m, x1: x1 + m, y1: y1 + m };
}

function inside(pts, x, y) {
  let c = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
  }
  return c;
}

export function shapeHit(o, x, y, r, page = { w: 3200, h: 1800 }) {
  const { pts, closed } = outline(o, page), p = [x, y], lim = r + o.w / 2;
  for (let i = 0; i + 1 < pts.length; i++) if (segDist(p, pts[i], pts[i + 1]) <= lim) return true;
  if (closed && pts.length > 2 && segDist(p, pts[pts.length - 1], pts[0]) <= lim) return true;
  return !!(o.fill && closed && inside(pts, x, y));
}

export function shapeInRect(o, x0, y0, x1, y1) {
  for (let i = 0; i < o.pts.length; i += 2) {
    const x = o.pts[i], y = o.pts[i + 1];
    if (x >= x0 && x <= x1 && y >= y0 && y <= y1) return true;
  }
  return false;
}

export function shapeShift(o, dx, dy) {
  return { ...o, pts: o.pts.map((v, i) => v + (i % 2 ? dy : dx)) };
}

// 스냅 후보가 되는 점들(꼭짓점, 원의 중심)
export function shapeVertices(o) {
  if (o.kind === 'rect') return rectPoints(o);
  if (o.kind === 'ray' || o.kind === 'line') return [P(o, 0), P(o, 1)];
  return polyPoints(o);
}

// ── 칠판 배경색과 글씨 대비 ──
// 배경색은 페이지마다(bg_color, 없으면 흰색). 그림·PDF·웹·동영상 배경 페이지는 색을 쓰지 않음.
// 어두운 칠판에서는 검정 글씨를 흰색으로, 밝은 칠판에서는 흰 글씨를 검정으로 '보이게만' 바꿈(저장된 색은 그대로)
export const BOARD_WHITE = '#ffffff';
export const BOARD_GREEN = '#24493a';
const PLAIN = new Set(['none', 'grid', 'dots', 'coord']);

export function pageColor(page) {
  return page && PLAIN.has(page.bg_type || 'none') && page.bg_color ? page.bg_color : BOARD_WHITE;
}

function lum(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
  if (!m) return 1;
  const [r, g, b] = [m[1], m[2], m[3]].map((x) => { const v = parseInt(x, 16) / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function isDarkColor(hex) { return lum(hex) < 0.18; }
export function isDarkPage(page) { return isDarkColor(pageColor(page)); }

// 칠판 색에 맞춘 글씨 색(검정↔흰색만). 색 배경이 아닌 페이지(그림·PDF 등)는 그대로
export function inkColor(c, page) {
  if (!page || !PLAIN.has(page.bg_type || 'none') || !c) return c;
  const L = lum(c);
  if (isDarkPage(page)) return L < 0.02 ? '#f4f4ef' : c;
  return L > 0.85 && lum(pageColor(page)) > 0.6 ? '#1d1d1b' : c;
}

let HALO = 'rgba(255,255,255,.9)';

// ── 그리기 ──
function label(ctx, text, x, y, color) {
  ctx.save();
  ctx.font = '600 30px system-ui, "Malgun Gothic", sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.lineWidth = 8; ctx.strokeStyle = HALO; ctx.lineJoin = 'round';
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color; ctx.fillText(text, x, y);
  ctx.restore();
}
const cm = (len) => `${(len / UNITS_PER_CM).toFixed(1).replace(/\.0$/, '')}cm`;

function sideLabels(ctx, pts, closed, o) {
  const n = closed ? pts.length : pts.length - 1;
  // 다각형 바깥쪽으로 조금 띄워서 표시
  const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length, cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
    let nx = -(b[1] - a[1]), ny = b[0] - a[0];
    const L = Math.hypot(nx, ny) || 1; nx /= L; ny /= L;
    if (closed && (mx + nx - cx) * nx + (my + ny - cy) * ny < 0) { nx = -nx; ny = -ny; }
    label(ctx, cm(dist(a, b)), mx + nx * 32, my + ny * 32, o.c);
  }
}

// 다각형 내각을 정수로 반올림하되 합이 (n-2)×180 이 되게(최대 나머지 방식)
function roundedInterior(ps) {
  const n = ps.length, raw = [];
  for (let i = 0; i < n; i++) {
    const v = ps[i], a = ps[(i + 1) % n], b = ps[(i + n - 1) % n];
    let d = Math.atan2(b[1] - v[1], b[0] - v[0]) - Math.atan2(a[1] - v[1], a[0] - v[0]);
    while (d < 0) d += Math.PI * 2;
    raw.push(deg(d));
  }
  const total = raw.reduce((x, y) => x + y, 0);
  if (total > (n - 2) * 180 + 1) for (let i = 0; i < n; i++) raw[i] = 360 - raw[i];   // 반대 방향으로 그린 경우
  const target = (n - 2) * 180;
  // 같은 크기의 각(차이 0.3° 미만)은 묶어서 평균으로 같은 숫자를 붙임(이등변삼각형 등)
  const groups = [];
  raw.forEach((x, i) => {
    const g = groups.find((q) => Math.abs(q.v - x) < 0.3);
    if (g) { g.idx.push(i); g.v = g.idx.reduce((s2, j) => s2 + raw[j], 0) / g.idx.length; } else groups.push({ v: x, idx: [i] });
  });
  let left = target;
  for (const g of groups) { g.f = Math.floor(g.v + 1e-6); left -= g.f * g.idx.length; }
  groups.sort((p, q) => (q.v - q.f) - (p.v - p.f));
  for (const g of groups) if (left >= g.idx.length && g.v - g.f > 1e-6) { g.f++; g.up = true; left -= g.idx.length; }
  const labels = new Array(n);
  for (const g of groups) {
    // 정수로 합을 맞출 수 없는 묶음(정칠각형 등)은 소수 한 자리
    const txt = (left > 0 && !g.up && g.v - g.f >= 0.05) ? `${g.v.toFixed(1)}°` : `${g.f}°`;
    g.idx.forEach((i) => { labels[i] = txt; });
  }
  return labels;
}

function angleMark(ctx, v, a, b, color, showLabel = true, text = null) {
  let t1 = Math.atan2(a[1] - v[1], a[0] - v[0]), t2 = Math.atan2(b[1] - v[1], b[0] - v[0]);
  let d = t2 - t1;
  while (d <= -Math.PI) d += Math.PI * 2;
  while (d > Math.PI) d -= Math.PI * 2;
  const R = 54;
  ctx.save();
  ctx.lineWidth = 3; ctx.strokeStyle = color;
  if (Math.abs(Math.abs(d) - Math.PI / 2) < 0.004) {            // 직각 표시
    const u = [Math.cos(t1) * 36, Math.sin(t1) * 36], w = [Math.cos(t2) * 36, Math.sin(t2) * 36];
    ctx.beginPath(); ctx.moveTo(v[0] + u[0], v[1] + u[1]); ctx.lineTo(v[0] + u[0] + w[0], v[1] + u[1] + w[1]); ctx.lineTo(v[0] + w[0], v[1] + w[1]); ctx.stroke();
  } else {
    ctx.beginPath(); ctx.arc(v[0], v[1], R, t1, t1 + d, d < 0); ctx.stroke();
  }
  ctx.restore();
  if (showLabel) {
    const mid = t1 + d / 2;
    label(ctx, text ?? `${Math.round(Math.abs(deg(d)))}°`, v[0] + Math.cos(mid) * (R + 42), v[1] + Math.sin(mid) * (R + 42), color);
  }
}

function arrowHead(ctx, a, b, size) {
  const t = Math.atan2(b[1] - a[1], b[0] - a[0]);
  ctx.beginPath();
  ctx.moveTo(b[0], b[1]);
  ctx.lineTo(b[0] - size * Math.cos(t - 0.45), b[1] - size * Math.sin(t - 0.45));
  ctx.lineTo(b[0] - size * Math.cos(t + 0.45), b[1] - size * Math.sin(t + 0.45));
  ctx.closePath();
  ctx.fillStyle = ctx.strokeStyle; ctx.fill();
}

export function drawShape(ctx, o, page = { w: 3200, h: 1800 }) {
  const c = inkColor(o.c, page), f = o.fill && inkColor(o.fill, page);
  if (c !== o.c || f !== o.fill) o = { ...o, c, fill: f };
  HALO = isDarkPage(page) ? 'rgba(0,0,0,.55)' : 'rgba(255,255,255,.9)';
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = o.c; ctx.lineWidth = o.w; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  const path = new Path2D();
  const { pts, closed } = outline(o, page);
  if (o.kind === 'circle' || o.kind === 'ellipse') {
    const c = P(o, 0);
    path.ellipse(c[0], c[1], o.kind === 'circle' ? o.r : o.rx, o.kind === 'circle' ? o.r : o.ry, 0, 0, Math.PI * 2);
  } else if (o.kind === 'arc' || o.kind === 'sector') {
    const c = P(o, 0);
    if (o.kind === 'sector') path.moveTo(c[0], c[1]);
    path.arc(c[0], c[1], o.r, o.a0, o.a1, o.a1 < o.a0);
    if (o.kind === 'sector') path.closePath();
  } else if (pts.length) {
    path.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) path.lineTo(pts[i][0], pts[i][1]);
    if (closed) path.closePath();
  }
  if (o.fill && (closed || o.kind === 'sector')) {
    ctx.globalAlpha = 0.18; ctx.fillStyle = o.fill; ctx.fill(path); ctx.globalAlpha = 1;
  }
  ctx.stroke(path);
  if (o.kind === 'arrow') arrowHead(ctx, P(o, 0), P(o, 1), Math.max(22, o.w * 4));
  // 점 표시: 선분·반직선·직선의 끝점과 원의 중심
  if (['segment', 'ray', 'line'].includes(o.kind)) {
    for (const p of o.kind === 'segment' ? [P(o, 0), P(o, 1)] : [P(o, 0)]) { ctx.beginPath(); ctx.arc(p[0], p[1], Math.max(5, o.w * 1.2), 0, 7); ctx.fillStyle = o.c; ctx.fill(); }
  }
  if (o.kind === 'circle' || o.kind === 'sector' || o.kind === 'arc') {
    const c = P(o, 0); ctx.beginPath(); ctx.arc(c[0], c[1], 5, 0, 7); ctx.fillStyle = o.c; ctx.fill();
  }
  if (o.kind === 'angle') angleMark(ctx, P(o, 0), P(o, 1), P(o, 2), o.c, true);
  if (o.labels) {
    if (o.kind === 'segment' || o.kind === 'arrow') sideLabels(ctx, [P(o, 0), P(o, 1)], false, o);
    else if (o.kind === 'rect') sideLabels(ctx, rectPoints(o).slice(0, 2).concat([rectPoints(o)[2]]), false, o);
    else if (o.kind === 'polygon') {
      const ps = polyPoints(o), degs = roundedInterior(ps);
      sideLabels(ctx, ps, true, o);
      for (let i = 0; i < ps.length; i++) angleMark(ctx, ps[i], ps[(i + 1) % ps.length], ps[(i + ps.length - 1) % ps.length], o.c, true, degs[i]);
    } else if (o.kind === 'circle') {
      const c = P(o, 0);
      ctx.setLineDash([10, 8]); ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(c[0], c[1]); ctx.lineTo(c[0] + o.r, c[1]); ctx.stroke(); ctx.setLineDash([]);
      label(ctx, `반지름 ${cm(o.r)}`, c[0] + o.r / 2, c[1] - 30, o.c);
    } else if (o.kind === 'sector' || o.kind === 'arc') {
      const c = P(o, 0);
      angleMark(ctx, c, [c[0] + Math.cos(o.a0) * o.r, c[1] + Math.sin(o.a0) * o.r], [c[0] + Math.cos(o.a1) * o.r, c[1] + Math.sin(o.a1) * o.r], o.c, true);
    }
  }
  ctx.restore();
}

// ── 페이지 배경 ──
// ── 자료 배경(사진·PDF 쪽·웹캠 캡처) ──
const IMG = new Map();          // asset → { img, ready, p }  (최근 것 위주로 16장까지)
const IMG_MAX = 16;

export function isImageBg(page) {
  return !!(page && (page.bg_type === 'image' || page.bg_type === 'pdf') && page.bg_meta && page.bg_meta.asset);
}

function imgEntry(page) {
  const a = page.bg_meta.asset;
  let e = IMG.get(a);
  if (e && e.failed && (Date.now() - e.failed > 30000 || e.url !== page.bg_url)) { IMG.delete(a); e = null; }
  if (e) { IMG.delete(a); IMG.set(a, e); return e; }
  if (!page.bg_url) return null;
  const img = new Image();
  img.decoding = 'async';
  e = { img, ready: false, failed: 0, url: page.bg_url, waiters: new Set() };
  e.p = new Promise((res) => {
    img.onload = () => { e.ready = true; res(img); e.waiters.forEach((f) => f()); e.waiters.clear(); };
    img.onerror = () => { e.failed = Date.now(); res(null); };   // 30초 동안은 다시 시도하지 않음
  });
  img.src = page.bg_url;
  IMG.set(a, e);
  while (IMG.size > IMG_MAX) IMG.delete(IMG.keys().next().value);
  return e;
}

// 스냅샷·인쇄처럼 한 번에 그려야 할 때 먼저 불러 둡니다
export function loadBgImage(page) {
  if (!isImageBg(page)) return Promise.resolve(null);
  const e = imgEntry(page);
  return e ? e.p : Promise.resolve(null);
}

export function bgImageRect(page) {
  const m = page.bg_meta || {}, iw = m.iw || page.w, ih = m.ih || page.h;
  const s = Math.min(page.w / iw, page.h / ih);
  return { x: (page.w - iw * s) / 2, y: (page.h - ih * s) / 2, w: iw * s, h: ih * s };
}

function drawImageBg(ctx, page, onLoad) {
  const e = imgEntry(page), r = bgImageRect(page);
  if (e && e.ready) { ctx.drawImage(e.img, r.x, r.y, r.w, r.h); return; }
  ctx.save();
  ctx.fillStyle = '#f1f1ee'; ctx.fillRect(r.x, r.y, r.w, r.h);
  ctx.fillStyle = '#9a9a94'; ctx.font = '40px system-ui, sans-serif'; ctx.textAlign = 'center';
  ctx.fillText(e && !e.failed ? '자료를 불러오는 중…' : '자료를 볼 수 없습니다', page.w / 2, Math.min(page.h / 2, 900));
  ctx.restore();
  if (e && !e.failed && onLoad) e.waiters.add(onLoad);
}

export function drawBackground(ctx, page, onLoad = null) {
  const t = page.bg_type, size = (page.bg_meta && page.bg_meta.size) || 80;
  if (page.camLive) {                   // 다른 기기에서 실시간 웹캠 배경을 쓰는 중
    ctx.save();
    ctx.fillStyle = '#e8ebf0'; ctx.fillRect(0, 0, page.w, page.h);
    ctx.fillStyle = '#8a93a3'; ctx.font = '48px system-ui, sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('전자칠판의 실시간 화면(웹캠·다른 탭) 위에 쓰는 중', page.w / 2, Math.min(page.h / 2, 900));
    ctx.font = '30px system-ui, sans-serif';
    ctx.fillText('끄거나 다음 장으로 넘기면 그 장면이 이 페이지에 남습니다', page.w / 2, Math.min(page.h / 2, 900) + 60);
    ctx.restore();
    return;
  }
  if (!t || t === 'none') return;
  if (isImageBg(page)) { drawImageBg(ctx, page, onLoad); return; }
  if (t === 'video') {                  // 스냅샷·기록: 동영상은 이름만 표시
    const m = page.bg_meta || {};
    ctx.save();
    ctx.fillStyle = '#1d2129'; ctx.fillRect(0, 0, page.w, page.h);
    const cx = page.w / 2, cy = page.h / 2 - 40;
    ctx.fillStyle = 'rgba(255,255,255,.18)'; ctx.beginPath(); ctx.arc(cx, cy, 110, 0, 7); ctx.fill();
    ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.moveTo(cx - 36, cy - 56); ctx.lineTo(cx + 62, cy); ctx.lineTo(cx - 36, cy + 56); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#c8cdd6'; ctx.font = '44px system-ui, sans-serif'; ctx.textAlign = 'center';
    const label = m.src === 'yt' ? `유튜브 동영상 (youtu.be/${m.yt || ''})` : `동영상 ${m.name || ''}`;
    ctx.fillText(label.length > 70 ? label.slice(0, 68) + '…' : label, cx, cy + 190);
    ctx.restore();
    return;
  }
  if (t === 'web') {                    // 스냅샷·기록: 웹페이지는 그릴 수 없어 주소만 표시
    ctx.save();
    ctx.fillStyle = '#f3f5f9'; ctx.fillRect(0, 0, page.w, page.h);
    ctx.fillStyle = '#7d8696'; ctx.font = '44px system-ui, sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('웹페이지', page.w / 2, page.h / 2 - 30);
    ctx.font = '30px system-ui, sans-serif';
    const u = String((page.bg_meta && page.bg_meta.url) || '');
    ctx.fillText(u.length > 90 ? u.slice(0, 88) + '…' : u, page.w / 2, page.h / 2 + 30);
    ctx.restore();
    return;
  }
  ctx.save();
  const dark = isDarkPage(page);
  if (t === 'grid' || t === 'coord') {
    ctx.strokeStyle = dark ? 'rgba(255,255,255,.2)' : '#cfd8e6'; ctx.lineWidth = 1.5;
    ctx.beginPath();
    const ox = t === 'coord' ? (page.w / 2) % size : 0, oy = t === 'coord' ? (page.h / 2) % size : 0;
    for (let x = ox; x <= page.w; x += size) { ctx.moveTo(x, 0); ctx.lineTo(x, page.h); }
    for (let y = oy; y <= page.h; y += size) { ctx.moveTo(0, y); ctx.lineTo(page.w, y); }
    ctx.stroke();
  }
  if (t === 'dots') {
    ctx.fillStyle = dark ? 'rgba(255,255,255,.45)' : '#9aa7ba';
    for (let x = size; x < page.w; x += size) for (let y = size; y < page.h; y += size) { ctx.beginPath(); ctx.arc(x, y, 4, 0, 7); ctx.fill(); }
  }
  if (t === 'coord') {
    const cx = page.w / 2, cy = page.h / 2;
    ctx.strokeStyle = dark ? '#d9dee6' : '#5b6678'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(30, cy); ctx.lineTo(page.w - 30, cy); ctx.moveTo(cx, page.h - 30); ctx.lineTo(cx, 30); ctx.stroke();
    ctx.fillStyle = dark ? '#d9dee6' : '#5b6678';
    for (const [a, b] of [[[30, cy], [page.w - 20, cy]], [[cx, page.h - 30], [cx, 20]]]) {
      const tt = Math.atan2(b[1] - a[1], b[0] - a[0]);
      ctx.beginPath(); ctx.moveTo(b[0], b[1]);
      ctx.lineTo(b[0] - 26 * Math.cos(tt - 0.4), b[1] - 26 * Math.sin(tt - 0.4));
      ctx.lineTo(b[0] - 26 * Math.cos(tt + 0.4), b[1] - 26 * Math.sin(tt + 0.4)); ctx.fill();
    }
    ctx.font = '24px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    const nx = Math.floor((page.w / 2 - 60) / size), ny = Math.floor((page.h / 2 - 60) / size);
    for (let i = -nx; i <= nx; i++) if (i) { ctx.fillText(String(i), cx + i * size, cy + 8); ctx.fillRect(cx + i * size - 1.5, cy - 8, 3, 16); }
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (let j = -ny; j <= ny; j++) if (j) { ctx.fillText(String(-j), cx - 12, cy + j * size); ctx.fillRect(cx - 8, cy + j * size - 1.5, 16, 3); }
    ctx.textAlign = 'right'; ctx.textBaseline = 'top'; ctx.fillText('0', cx - 10, cy + 8);
    ctx.font = 'italic 30px serif'; ctx.textAlign = 'left'; ctx.fillText('x', page.w - 44, cy + 14); ctx.fillText('y', cx + 14, 18);
  }
  ctx.restore();
}

// 배경 격자점(스냅용)
export function gridSnap(page, x, y) {
  const t = page.bg_type, size = (page.bg_meta && page.bg_meta.size) || 80;
  if (!t || t === 'none') return null;
  const ox = t === 'coord' ? (page.w / 2) % size : 0, oy = t === 'coord' ? (page.h / 2) % size : 0;
  return [Math.round((x - ox) / size) * size + ox, Math.round((y - oy) / size) * size + oy];
}
