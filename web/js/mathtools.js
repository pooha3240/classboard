// 수학 도구: 도형 그리기, 자·삼각자·각도기, 컴퍼스, 각 재기, 배경, 스냅, cm 보정
import { newId } from './model.js';
import { drawShape, shapeVertices, gridSnap, unitsPerCm, setUnitsPerCm } from './shapes.js';

const $ = (s, el = document) => el.querySelector(s);
const ls = {
  get(k, d) { try { const v = localStorage.getItem('eboard.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('eboard.' + k, JSON.stringify(v)); } catch { /* 무시 */ } },
};
const SNAP_PX = 16, EDGE_PX = 26;
const D2R = Math.PI / 180;

// ── 도구(자·삼각자·각도기) ──
const SHAPES = {
  ruler: { label: '자', poly: (u) => [[-15.5, -1.75], [15.5, -1.75], [15.5, 1.75], [-15.5, 1.75]].map(([x, y]) => [x * u, y * u]), handle: (u) => [13.8 * u, 0.4 * u] },
  set45: { label: '삼각자 45°', poly: (u) => [[0, 0], [16, 0], [0, -16]].map(([x, y]) => [(x - 5.3) * u, (y + 5.3) * u]), handle: (u) => [2.3 * u, -2.3 * u] },
  set60: { label: '삼각자 30°·60°', poly: (u) => [[0, 0], [22.5, 0], [0, -13]].map(([x, y]) => [(x - 7.5) * u, (y + 4.3) * u]), handle: (u) => [2.6 * u, -2.2 * u] },
  protractor: { label: '각도기', poly: (u) => { const R = 9 * u, out = [[-R - 0.4 * u, 0.6 * u], [R + 0.4 * u, 0.6 * u]]; for (let i = 0; i <= 36; i++) { const t = Math.PI * i / 36; out.push([Math.cos(t) * R * (i ? 1 : 1.04), -Math.sin(t) * R]); } return out; }, handle: (u) => [0, -5.2 * u] },
};

class Instrument {
  constructor(type, cx, cy, a = 0) { Object.assign(this, { type, cx, cy, a }); }
  toWorld([x, y]) { const c = Math.cos(this.a), s = Math.sin(this.a); return [this.cx + x * c - y * s, this.cy + x * s + y * c]; }
  toLocal([x, y]) { const c = Math.cos(-this.a), s = Math.sin(-this.a), dx = x - this.cx, dy = y - this.cy; return [dx * c - dy * s, dx * s + dy * c]; }
  poly() { return SHAPES[this.type].poly(unitsPerCm()).map((p) => this.toWorld(p)); }
  handle() { return this.toWorld(SHAPES[this.type].handle(unitsPerCm())); }
  // 펜이 붙는 가장자리
  edges() {
    const u = unitsPerCm();
    if (this.type === 'protractor') { const R = 9 * u; return [[this.toWorld([-R, 0]), this.toWorld([R, 0])]]; }
    const p = this.poly();
    if (this.type === 'ruler') return [[p[0], p[1]], [p[3], p[2]]];
    return [[p[0], p[1]], [p[1], p[2]], [p[2], p[0]]];
  }
  contains(pt) {
    const ps = this.poly(); let c = false;
    for (let i = 0, j = ps.length - 1; i < ps.length; j = i++) {
      const [xi, yi] = ps[i], [xj, yj] = ps[j];
      if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi) c = !c;
    }
    return c;
  }

  draw(ctx, s) {
    const u = unitsPerCm(), ps = this.poly();
    ctx.save();
    ctx.beginPath(); ps.forEach((p, i) => (i ? ctx.lineTo(...p) : ctx.moveTo(...p))); ctx.closePath();
    ctx.fillStyle = 'rgba(250, 244, 214, 0.62)'; ctx.fill();
    ctx.lineWidth = 2 / s; ctx.strokeStyle = '#8a7a40'; ctx.stroke();
    ctx.translate(this.cx, this.cy); ctx.rotate(this.a);
    ctx.strokeStyle = '#5a4f22'; ctx.fillStyle = '#5a4f22';
    ctx.font = `${0.42 * u}px system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    const tick = (x0, y0, len, dirY) => { ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x0, y0 + len * dirY); ctx.stroke(); };
    if (this.type === 'ruler') {
      ctx.lineWidth = 1.4 / s;
      for (let mm = 0; mm <= 300; mm++) {
        const x = (-15 + mm / 10) * u, L = mm % 10 === 0 ? 0.8 : mm % 5 === 0 ? 0.55 : 0.32;
        tick(x, -1.75 * u, L * u, 1);
        if (mm % 10 === 0) ctx.fillText(String(mm / 10), x, -0.85 * u);
      }
    } else if (this.type === 'set45' || this.type === 'set60') {
      const [x0, y0] = SHAPES[this.type].poly(u)[0], len = this.type === 'set45' ? 16 : 22.5;
      ctx.lineWidth = 1.4 / s;
      for (let mm = 0; mm <= (len - 0.5) * 10; mm++) {
        const L = mm % 10 === 0 ? 0.7 : mm % 5 === 0 ? 0.5 : 0.3;
        tick(x0 + mm / 10 * u, y0, -L * u, 1);
        if (mm % 10 === 0 && mm) ctx.fillText(String(mm / 10), x0 + mm / 10 * u, y0 - 1.3 * u);
      }
      ctx.beginPath(); ctx.rect(x0 + 0.1 * u, y0 - 0.9 * u, 0.8 * u, 0.8 * u); ctx.stroke();    // 직각 표시
    } else if (this.type === 'protractor') {
      const R = 9 * u;
      ctx.lineWidth = 1.3 / s;
      for (let d = 0; d <= 180; d++) {
        const t = d * D2R, L = d % 10 === 0 ? 0.9 : d % 5 === 0 ? 0.6 : 0.35;
        ctx.beginPath(); ctx.moveTo(Math.cos(t) * R, -Math.sin(t) * R); ctx.lineTo(Math.cos(t) * (R - L * u), -Math.sin(t) * (R - L * u)); ctx.stroke();
        if (d % 10 === 0) {
          ctx.save(); ctx.translate(Math.cos(t) * (R - 1.45 * u), -Math.sin(t) * (R - 1.45 * u)); ctx.rotate(Math.PI / 2 - t);
          ctx.fillText(String(180 - d), 0, 0); ctx.restore();
          ctx.save(); ctx.translate(Math.cos(t) * (R - 2.25 * u), -Math.sin(t) * (R - 2.25 * u)); ctx.rotate(Math.PI / 2 - t);
          ctx.globalAlpha = 0.6; ctx.fillText(String(d), 0, 0); ctx.restore();
        }
      }
      ctx.lineWidth = 1.6 / s;
      ctx.beginPath(); ctx.moveTo(-R, 0); ctx.lineTo(R, 0); ctx.moveTo(0, 0); ctx.lineTo(0, -1.2 * u); ctx.stroke();
      ctx.beginPath(); ctx.arc(0, 0, 0.18 * u, 0, 7); ctx.fill();
    }
    ctx.restore();
    // 회전 손잡이
    const h = this.handle();
    ctx.save();
    ctx.beginPath(); ctx.arc(h[0], h[1], 0.75 * u, 0, 7);
    ctx.fillStyle = 'rgba(27,95,209,.16)'; ctx.fill(); ctx.lineWidth = 2 / s; ctx.strokeStyle = '#1b5fd1'; ctx.stroke();
    ctx.font = `${0.9 * u}px system-ui`; ctx.fillStyle = '#1b5fd1'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('↻', h[0], h[1] + 0.05 * u);
    ctx.font = `600 ${0.42 * u}px system-ui`; ctx.fillText(`${((Math.round(this.a / D2R) % 360) + 360) % 360}°`, h[0], h[1] + 1.25 * u);
    ctx.restore();
  }
}

function project(pt, [a, b], margin) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
  let t = ((pt[0] - a[0]) * dx + (pt[1] - a[1]) * dy) / L;
  const m = margin / Math.sqrt(L);
  t = Math.max(-m, Math.min(1 + m, t));
  return [a[0] + t * dx, a[1] + t * dy];
}
function segDist(p, a, b) { const q = project(p, [a, b], 0); return Math.hypot(q[0] - p[0], q[1] - p[1]); }

export const SHAPE_TOOLS = [
  ['segment', '선분'], ['ray', '반직선'], ['line', '직선'], ['arrow', '화살표'],
  ['rect', '직사각형'], ['triangle', '삼각형'], ['polygon', '다각형'], ['regular', '정다각형'],
  ['circle', '원'], ['ellipse', '타원'], ['sector', '부채꼴'], ['angle', '각 재기'], ['compass', '컴퍼스'],
];

export class MathTools {
  constructor({ tools, board, renderer, net, toast }) {
    Object.assign(this, { tools, board, r: renderer, net, toast });
    this.instruments = new Map();
    this.kind = 'segment';
    this.labels = ls.get('m.labels', true);
    this.angleSnap = ls.get('m.angleSnap', true);
    this.fill = ls.get('m.fill', false);
    this.regularN = ls.get('m.n', 5);
    this.taps = [];             // 다각형·각·부채꼴의 찍은 점들
    this.compass = null;        // {c, r}
    this.snapMark = null;
    this.hover = null;
    const saved = ls.get('upc', null);
    if (saved) setUnitsPerCm(saved);
    this._buildPanel();
  }

  color() { return this.tools.color; }
  width() { return [3, 5, 9][this.tools.sizeIdx]; }
  active() { return this.tools.tool === 'shape'; }

  // ── 스냅 ──
  snap(pt, skipIds = null) {
    const lim = SNAP_PX / this.r.view.s;
    let best = null, bd = lim;
    for (const o of this.board.objs.values()) {
      if (o.t !== 'shape' || (skipIds && skipIds.has(o.id))) continue;
      for (const v of shapeVertices(o)) { const d = Math.hypot(v[0] - pt[0], v[1] - pt[1]); if (d < bd) { bd = d; best = v; } }
    }
    if (this.compass) { const c = this.compass.c, d = Math.hypot(c[0] - pt[0], c[1] - pt[1]); if (d < bd) { bd = d; best = c; } }
    for (const p of this.taps) { const d = Math.hypot(p[0] - pt[0], p[1] - pt[1]); if (d < bd) { bd = d; best = p; } }
    if (!best && this.board.page) {
      const g = gridSnap(this.board.page, pt[0], pt[1]);
      if (g && Math.hypot(g[0] - pt[0], g[1] - pt[1]) < lim) best = g;
    }
    this.snapMark = best;
    return best ? [...best] : pt;
  }

  snapAngle(a, b) {
    if (!this.angleSnap) return b;
    const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy);
    const t = Math.atan2(dy, dx), step = 15 * D2R, q = Math.round(t / step) * step;
    if (Math.abs(t - q) > 4 * D2R) return b;
    return [a[0] + Math.cos(q) * L, a[1] + Math.sin(q) * L];
  }

  // ── 펜이 자 가장자리에 붙기 ──
  handleAt(pt) {
    for (const ins of this.instruments.values()) {
      const h = ins.handle();
      if (Math.hypot(h[0] - pt.x, h[1] - pt.y) < unitsPerCm() * 1.1) return ins;
    }
    return null;
  }

  edgeAt(pt) {
    const lim = Math.min(EDGE_PX / this.r.view.s, unitsPerCm() * 0.9);
    let best = null, bd = lim;
    for (const ins of this.instruments.values()) for (const e of ins.edges()) {
      const d = segDist([pt.x, pt.y], e[0], e[1]);
      if (d < bd) { bd = d; best = e; }
    }
    return best;
  }
  project(pt, edge) { const q = project([pt.x, pt.y], edge, unitsPerCm()); return { x: q[0], y: q[1] }; }

  // ── 포인터 ──
  down(p, pt, e) {
    const P = [pt.x, pt.y];
    // 도구 손잡이·몸통은 어떤 도구를 쓰든 먼저
    for (const ins of [...this.instruments.values()].reverse()) {
      const h = ins.handle();
      if (Math.hypot(h[0] - P[0], h[1] - P[1]) < unitsPerCm() * 1.1) { p.m = { mode: 'rotate', ins, a0: ins.a, t0: Math.atan2(P[1] - ins.cy, P[0] - ins.cx) }; return true; }
      if (ins.contains(P)) { p.m = { mode: 'move', ins, last: P }; return true; }
    }
    if (!this.active()) return false;
    const k = this.kind;
    const S = this.snap(P);
    if (k === 'compass') {
      if (!this.compass || Math.hypot(this.compass.c[0] - S[0], this.compass.c[1] - S[1]) < SNAP_PX / this.r.view.s) {
        this.compass = { c: S, r: 0 }; p.m = { mode: 'compass-r' };
      } else {
        const c = this.compass.c, t = Math.atan2(P[1] - c[1], P[0] - c[0]);
        p.m = { mode: 'compass-arc', a0: t, a1: t, last: t };
      }
      return true;
    }
    if (k === 'polygon' || k === 'triangle' || k === 'angle' || k === 'sector') { p.m = { mode: 'tap', at: S }; this.hover = S; return true; }
    p.m = { mode: 'drag', a: S, b: S };
    return true;
  }

  move(p, pt) {
    const m = p.m, P = [pt.x, pt.y];
    if (m.mode === 'move') { m.ins.cx += P[0] - m.last[0]; m.ins.cy += P[1] - m.last[1]; m.last = P; this._sync(); }
    else if (m.mode === 'rotate') {
      let a = m.a0 + Math.atan2(P[1] - m.ins.cy, P[0] - m.ins.cx) - m.t0;
      const deg = a / D2R, near = Math.round(deg / 15) * 15;
      a = (Math.abs(deg - near) < 2 ? near : Math.round(deg)) * D2R;        // 1° 단위, 15° 근처는 자석
      m.ins.a = a; this._sync();
    } else if (m.mode === 'compass-r') {
      const S = this.snap(P), c = this.compass.c; this.compass.r = Math.hypot(S[0] - c[0], S[1] - c[1]);
    } else if (m.mode === 'compass-arc') {
      const c = this.compass.c, t = Math.atan2(P[1] - c[1], P[0] - c[0]);
      let d = t - m.last; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
      m.a1 += d; m.last = t;
      m.a1 = Math.max(m.a0 - 2 * Math.PI, Math.min(m.a0 + 2 * Math.PI, m.a1));
    } else if (m.mode === 'tap') { this.hover = this.snap(P); }
    else if (m.mode === 'drag') {
      let S = this.snap(P);
      if (['segment', 'ray', 'line', 'arrow'].includes(this.kind) && !this.snapMark) S = this.snapAngle(m.a, S);
      m.b = S;
    }
  }

  up(p, pt) {
    const m = p.m, P = [pt.x, pt.y];
    this.snapMark = null;
    if (m.mode === 'move' || m.mode === 'rotate') return;
    if (m.mode === 'compass-r') {
      if (this.compass.r < 10) this.toast('컴퍼스: 중심에서 끌어 반지름을 정하세요');
      else this.toast('이제 돌려서 원·호를 그리세요. 중심을 다시 누르면 새로 정합니다');
      return;
    }
    if (m.mode === 'compass-arc') {
      const sweep = m.a1 - m.a0;
      if (Math.abs(sweep) < 2 * D2R) return;
      const { c, r } = this.compass;
      if (Math.abs(sweep) >= 2 * Math.PI - 0.02) this._add({ kind: 'circle', pts: c, r });
      else this._add({ kind: 'arc', pts: c, r, a0: Math.min(m.a0, m.a1), a1: Math.max(m.a0, m.a1) });
      return;
    }
    if (m.mode === 'tap') { this._tap(this.snap(P)); this.snapMark = null; return; }
    if (m.mode === 'drag') {
      const a = m.a, b = m.b, L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (L < 8 / this.r.view.s) return;
      const k = this.kind;
      if (['segment', 'ray', 'line', 'arrow'].includes(k)) this._add({ kind: k, pts: [...a, ...b] });
      else if (k === 'rect') this._add({ kind: 'rect', pts: [...a, ...b] });
      else if (k === 'circle') this._add({ kind: 'circle', pts: a, r: L });
      else if (k === 'ellipse') this._add({ kind: 'ellipse', pts: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], rx: Math.abs(b[0] - a[0]) / 2, ry: Math.abs(b[1] - a[1]) / 2 });
      else if (k === 'regular') {
        const n = this.regularN, t0 = Math.atan2(b[1] - a[1], b[0] - a[0]), pts = [];
        for (let i = 0; i < n; i++) { const t = t0 + i * 2 * Math.PI / n; pts.push(a[0] + L * Math.cos(t), a[1] + L * Math.sin(t)); }
        this._add({ kind: 'polygon', pts });
      }
    }
  }

  _tap(S) {
    const k = this.kind, t = this.taps;
    if (k === 'polygon' && t.length >= 3 && Math.hypot(t[0][0] - S[0], t[0][1] - S[1]) < SNAP_PX * 1.5 / this.r.view.s) {
      this._add({ kind: 'polygon', pts: t.flat() }); this.taps = []; return;
    }
    t.push(S);
    if (k === 'triangle' && t.length === 3) { this._add({ kind: 'polygon', pts: t.flat() }); this.taps = []; }
    else if (k === 'angle' && t.length === 3) { this._add({ kind: 'angle', pts: t.flat(), labels: true }); this.taps = []; }
    else if (k === 'sector' && t.length === 3) {
      const [c, a, b] = t, r = Math.hypot(a[0] - c[0], a[1] - c[1]);
      let a0 = Math.atan2(a[1] - c[1], a[0] - c[0]), a1 = Math.atan2(b[1] - c[1], b[0] - c[0]);
      if (a1 < a0) a1 += 2 * Math.PI;
      this._add({ kind: 'sector', pts: c, r, a0, a1 }); this.taps = [];
    } else if (k === 'polygon' && t.length === 1) this.toast('꼭짓점을 차례로 찍고, 첫 점을 다시 찍으면 완성됩니다');
  }

  _add(d) {
    const id = newId();
    const obj = { t: 'shape', c: this.color(), w: this.width(), fill: this.fill && ['rect', 'polygon', 'circle', 'ellipse', 'sector'].includes(d.kind) ? this.color() : null,
                  labels: d.labels ?? this.labels, ...d, pts: d.pts.map((v) => Math.round(v * 10) / 10) };
    this.tools.commit([{ k: 'add', id, d: obj }], [{ k: 'remove', id }]);
  }

  resetTaps() { this.taps = []; this.compass = null; this.hover = null; this.r.requestLive(); }

  // ── 실시간 캔버스 ──
  overlay(ctx, pointers) {
    const s = this.r.view.s;
    for (const ins of this.instruments.values()) ins.draw(ctx, s);
    const page = this.board.page || { w: 3200, h: 1800 };
    const ghost = (d) => drawShape(ctx, { t: 'shape', c: this.color(), w: this.width(), fill: null, labels: this.labels, ...d }, page);
    const m = [...pointers.values()].map((p) => p.m).find(Boolean);
    if (m && m.mode === 'drag' && this.active()) {
      const a = m.a, b = m.b, L = Math.hypot(b[0] - a[0], b[1] - a[1]), k = this.kind;
      if (L > 1) {
        if (['segment', 'ray', 'line', 'arrow', 'rect'].includes(k)) ghost({ kind: k, pts: [...a, ...b] });
        else if (k === 'circle') ghost({ kind: 'circle', pts: a, r: L });
        else if (k === 'ellipse') ghost({ kind: 'ellipse', pts: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], rx: Math.abs(b[0] - a[0]) / 2, ry: Math.abs(b[1] - a[1]) / 2 });
        else if (k === 'regular') {
          const n = this.regularN, t0 = Math.atan2(b[1] - a[1], b[0] - a[0]), pts = [];
          for (let i = 0; i < n; i++) { const t = t0 + i * 2 * Math.PI / n; pts.push(a[0] + L * Math.cos(t), a[1] + L * Math.sin(t)); }
          ghost({ kind: 'polygon', pts });
        }
      }
    }
    if (this.taps.length && this.active()) {
      const h = this.hover || this.taps[this.taps.length - 1];
      const pts = [...this.taps, h];
      if (this.kind === 'angle' && pts.length >= 2) ghost({ kind: 'angle', pts: (pts.length === 2 ? [...pts, pts[1]] : pts).flat(), labels: pts.length === 3 });
      else if (this.kind === 'sector' && pts.length >= 2) {
        const [c, a, b] = pts; const r = Math.hypot(a[0] - c[0], a[1] - c[1]);
        if (!b) ghost({ kind: 'segment', pts: [...c, ...a] });
        else { let a0 = Math.atan2(a[1] - c[1], a[0] - c[0]), a1 = Math.atan2(b[1] - c[1], b[0] - c[0]); if (a1 < a0) a1 += 2 * Math.PI; ghost({ kind: 'sector', pts: c, r, a0, a1 }); }
      } else {
        ctx.save(); ctx.strokeStyle = this.color(); ctx.lineWidth = this.width(); ctx.setLineDash([12 / s, 8 / s]);
        ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(...p) : ctx.moveTo(...p))); ctx.stroke(); ctx.restore();
      }
      for (const p of this.taps) { ctx.beginPath(); ctx.arc(p[0], p[1], 7 / s, 0, 7); ctx.fillStyle = this.color(); ctx.fill(); }
    }
    if (this.compass && this.active() && this.kind === 'compass') {
      const { c, r } = this.compass;
      ctx.save();
      ctx.strokeStyle = '#1b5fd1'; ctx.lineWidth = 2 / s; ctx.setLineDash([8 / s, 6 / s]);
      ctx.beginPath(); ctx.arc(c[0], c[1], r, 0, 7); ctx.stroke(); ctx.setLineDash([]);
      ctx.beginPath(); ctx.arc(c[0], c[1], 7 / s, 0, 7); ctx.fillStyle = '#1b5fd1'; ctx.fill();
      ctx.font = `600 ${16 / s}px system-ui`; ctx.fillText(`반지름 ${(r / unitsPerCm()).toFixed(1)}cm`, c[0] + 12 / s, c[1] - 12 / s);
      if (m && m.mode === 'compass-arc') {
        ctx.strokeStyle = this.color(); ctx.lineWidth = this.width();
        ctx.beginPath(); ctx.arc(c[0], c[1], r, m.a0, m.a1, m.a1 < m.a0); ctx.stroke();
        const t = m.a1; ctx.lineWidth = 2 / s; ctx.strokeStyle = '#1b5fd1';
        ctx.beginPath(); ctx.moveTo(c[0], c[1]); ctx.lineTo(c[0] + Math.cos(t) * r, c[1] + Math.sin(t) * r); ctx.stroke();
      }
      ctx.restore();
    }
    if (this.snapMark) {
      ctx.beginPath(); ctx.arc(this.snapMark[0], this.snapMark[1], 10 / s, 0, 7);
      ctx.lineWidth = 2.5 / s; ctx.strokeStyle = '#f08a00'; ctx.stroke();
    }
  }

  // ── 도구 켜고 끄기, 동기화 ──
  toggleInstrument(type) {
    if (this.instruments.has(type)) this.instruments.delete(type);
    else {
      const v = this.r.view, cx = (this.r.cw / 2 - v.ox) / v.s, cy = (this.r.ch / 2 - v.oy) / v.s;
      this.instruments.set(type, new Instrument(type, cx, cy, 0));
    }
    this._sync(true); this._syncPanel(); this.r.requestLive();
  }

  _sync(now = false) {
    clearTimeout(this._st);
    const send = () => this.net.connected && this.net.socket.emit('tool:event', { kind: 'instr', items: [...this.instruments.values()].map(({ type, cx, cy, a }) => ({ type, cx, cy, a })) });
    if (now) send(); else this._st = setTimeout(send, 100);
  }

  onRemote(d) {
    if (d.kind === 'instr') {
      this.instruments = new Map(d.items.filter((x) => SHAPES[x.type]).map((x) => [x.type, new Instrument(x.type, x.cx, x.cy, x.a)]));
      this._syncPanel(); this.r.requestLive();
    } else if (d.kind === 'calib' && d.upc) {
      setUnitsPerCm(d.upc); ls.set('upc', d.upc); this.r.requestMain(); this.r.requestLive();
    }
  }

  // ── 패널 ──
  _buildPanel() {
    const el = document.createElement('aside');
    el.id = 'math-panel'; el.className = 'math-panel'; el.hidden = true;
    el.innerHTML = `
      <header><strong>수학 도구</strong><button type="button" class="ct-close" aria-label="닫기">✕</button></header>
      <div class="mp-body">
        <h4>도형</h4><div class="mp-grid" id="mp-shapes">${SHAPE_TOOLS.map(([k, l]) => `<button type="button" data-k="${k}">${l}</button>`).join('')}</div>
        <div class="mp-row" id="mp-n-row"><label>정다각형 <select id="mp-n">${[3, 4, 5, 6, 7, 8, 9, 10, 12].map((n) => `<option ${n === this.regularN ? 'selected' : ''}>${n}</option>`).join('')}</select>각형</label></div>
        <div class="mp-row">
          <label class="check"><input type="checkbox" id="mp-labels" ${this.labels ? 'checked' : ''}> 길이·각도</label>
          <label class="check"><input type="checkbox" id="mp-snap" ${this.angleSnap ? 'checked' : ''}> 15° 맞춤</label>
          <label class="check"><input type="checkbox" id="mp-fill" ${this.fill ? 'checked' : ''}> 색 채우기</label>
        </div>
        <h4>재는 도구 <span class="muted small">(끌어서 옮기고 ↻로 돌림, 펜을 가장자리에 대면 곧게)</span></h4>
        <div class="mp-grid" id="mp-instr">${Object.entries(SHAPES).map(([k, s]) => `<button type="button" data-i="${k}">${s.label}</button>`).join('')}</div>
        <h4>배경</h4>
        <div class="mp-grid" id="mp-bg">${[['none', '없음'], ['grid', '모눈'], ['dots', '점판'], ['coord', '좌표평면']].map(([k, l]) => `<button type="button" data-bg="${k}">${l}</button>`).join('')}</div>
        <div class="mp-row"><label>칸 크기 <select id="mp-size">${[['0.5', 0.5], ['1', 1], ['1.5', 1.5], ['2', 2]].map(([l, v]) => `<option value="${v}" ${v === 1 ? 'selected' : ''}>${l}cm</option>`).join('')}</select></label></div>
        <h4>cm 맞추기 <span class="muted small">(전자칠판에서: 실물 자를 대고 화면의 10cm 를 맞춤)</span></h4>
        <div class="mp-row"><button type="button" class="chip" id="mp-cal">보정 시작</button><span class="muted small" id="mp-upc"></span></div>
      </div>`;
    document.body.appendChild(el);
    el.querySelector('.ct-close').onclick = () => { el.hidden = true; };
    $('#mp-shapes', el).onclick = (e) => {
      const k = e.target.dataset.k; if (!k) return;
      this.kind = k; this.tools.tool = 'shape'; this.taps = []; if (k !== 'compass') this.compass = null;
      el.hidden = true;                          // 칠판을 가리지 않게 고르면 닫힘('수학'을 누르면 다시 열림)
      this.tools.onChange(); this._syncPanel(); this.r.requestLive();
      const hint = { triangle: '꼭짓점 세 개를 찍으세요', angle: '꼭짓점 → 한 변 → 다른 변 순서로 찍으세요', sector: '중심 → 반지름 끝 → 다른 끝 순서로 찍으세요',
        compass: '중심을 누르고 끌어 반지름을 정한 뒤, 돌려서 그리세요', regular: '중심에서 꼭짓점까지 끄세요' }[k];
      if (hint) this.toast(hint);
    };
    $('#mp-n', el).onchange = (e) => { this.regularN = +e.target.value; ls.set('m.n', this.regularN); };
    $('#mp-labels', el).onchange = (e) => { this.labels = e.target.checked; ls.set('m.labels', this.labels); };
    $('#mp-snap', el).onchange = (e) => { this.angleSnap = e.target.checked; ls.set('m.angleSnap', this.angleSnap); };
    $('#mp-fill', el).onchange = (e) => { this.fill = e.target.checked; ls.set('m.fill', this.fill); };
    $('#mp-instr', el).onclick = (e) => { const k = e.target.dataset.i; if (k) this.toggleInstrument(k); };
    $('#mp-bg', el).onclick = (e) => { const bg = e.target.dataset.bg; if (bg) this.setBg(bg); };
    $('#mp-cal', el).onclick = () => this._calibrate();
    this.panel = el;
    this._syncPanel();
  }

  // 배경 바꾸기(빠른 도구에서도 씀). 같은 배경을 다시 고르면 없앰(toggle=true)
  async setBg(bg, toggle = false) {
    if (!this.board.page) return;
    if (toggle && this.board.page.bg_type === bg) bg = 'none';
    const size = Math.round(+$('#mp-size', this.panel).value * unitsPerCm());
    const r = await this.net.call('page:bg', { page_id: this.board.page.id, bg_type: bg, bg_meta: { size } }).catch(() => null);
    if (!r || !r.ok) this.toast('배경을 바꾸지 못했습니다');
  }

  _syncPanel() {
    const el = this.panel; if (!el) return;
    for (const b of el.querySelectorAll('#mp-shapes button')) b.classList.toggle('on', this.active() && b.dataset.k === this.kind);
    for (const b of el.querySelectorAll('#mp-instr button')) b.classList.toggle('on', this.instruments.has(b.dataset.i));
    const bg = this.board.page ? this.board.page.bg_type : 'none';
    for (const b of el.querySelectorAll('#mp-bg button')) b.classList.toggle('on', b.dataset.bg === (bg || 'none'));
    $('#mp-n-row', el).hidden = this.kind !== 'regular';
    $('#mp-upc', el).textContent = `지금 1cm = ${unitsPerCm().toFixed(1)}칸`;
  }

  toggle() { this.panel.hidden = !this.panel.hidden; if (!this.panel.hidden) this._syncPanel(); }

  // 자를 화면 가로로 띄우고 +/- 로 실물 10cm 에 맞춤
  _calibrate() {
    if (!this.instruments.has('ruler')) this.toggleInstrument('ruler');
    const ins = this.instruments.get('ruler'); ins.a = 0;
    const box = document.createElement('div');
    box.className = 'mp-cal';
    box.innerHTML = `<span>실물 자의 0~10cm 를 화면 자에 대고 맞추세요</span>
      <button type="button" class="chip" data-d="-1">줄이기 −</button><button type="button" class="chip" data-d="1">늘리기 +</button>
      <button type="button" class="chip primary" data-ok>완료</button>`;
    document.body.appendChild(box);
    const prevView = { ...this.r.view };
    this.r.fit();
    box.onclick = (e) => {
      if (e.target.dataset.d) { setUnitsPerCm(unitsPerCm() * (1 + 0.005 * +e.target.dataset.d)); this.r.requestLive(); }
      if (e.target.dataset.ok !== undefined) {
        ls.set('upc', unitsPerCm());
        this.net.connected && this.net.socket.emit('tool:event', { kind: 'calib', upc: unitsPerCm() });
        box.remove(); this._syncPanel(); this.r.requestMain(); this.toast('cm 를 맞췄습니다');
        Object.assign(this.r.view, prevView); this.r.redraw();
      }
    };
  }
}
