// 판서 객체 모델: 객체 보관, 동작 적용, 획 모양 계산, 충돌 판정
import { getStroke } from '../vendor/perfect-freehand.js';
import { shapeBBox, shapeHit, shapeInRect } from './shapes.js';

export function newId() {
  const a = new Uint8Array(9);
  crypto.getRandomValues(a);
  return btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_');
}

function strokeOptions(o, last) {
  const hl = o.tool === 'hl';
  return {
    size: o.w,
    thinning: hl ? 0 : (o.sp ? 0.55 : 0.6),
    smoothing: 0.5,
    streamline: hl ? 0.6 : 0.45,
    simulatePressure: !!o.sp,
    last,
  };
}

const avg = (a, b) => (a + b) / 2;

function outlineToPath(pts) {
  const n = pts.length;
  if (n < 4) return null;
  let a = pts[0], b = pts[1];
  const c = pts[2];
  let d = `M${a[0].toFixed(1)},${a[1].toFixed(1)} Q${b[0].toFixed(1)},${b[1].toFixed(1)} ${avg(b[0], c[0]).toFixed(1)},${avg(b[1], c[1]).toFixed(1)} T`;
  for (let i = 2; i < n - 1; i++) {
    a = pts[i]; b = pts[i + 1];
    d += `${avg(a[0], b[0]).toFixed(1)},${avg(a[1], b[1]).toFixed(1)} `;
  }
  return new Path2D(d + 'Z');
}

export function strokePath(o, last = true) {
  const p = o.pts, input = [];
  for (let i = 0; i < p.length; i += 3) input.push([p[i], p[i + 1], p[i + 2] / 255]);
  const path = outlineToPath(getStroke(input, strokeOptions(o, last)));
  if (path) return path;
  const dot = new Path2D();                      // 한 점(탭)
  dot.arc(p[0], p[1], o.w / 2, 0, Math.PI * 2);
  return dot;
}

export function strokeBBox(o) {
  const p = o.pts;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < p.length; i += 3) {
    if (p[i] < x0) x0 = p[i];
    if (p[i] > x1) x1 = p[i];
    if (p[i + 1] < y0) y0 = p[i + 1];
    if (p[i + 1] > y1) y1 = p[i + 1];
  }
  const m = o.w / 2 + 2;
  return { x0: x0 - m, y0: y0 - m, x1: x1 + m, y1: y1 + m };
}

function segDist2(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const L = dx * dx + dy * dy;
  let t = L ? ((px - ax) * dx + (py - ay) * dy) / L : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const x = ax + t * dx - px, y = ay + t * dy - py;
  return x * x + y * y;
}

export class Board {
  constructor() {
    this.objs = new Map();     // 삽입 순서 = 그리는 순서 (서버와 동일)
    this._path = new Map();
    this._bbox = new Map();
    this.page = null;
    this.seq = 0;
  }

  load(page) {
    this.page = { id: page.id, page_no: page.page_no, w: page.w, h: page.h, bg_type: page.bg_type, bg_meta: page.bg_meta || {}, bg_url: page.bg_url || null, bg_color: page.bg_color || null, play: page.play || null };
    this.objs.clear(); this._path.clear(); this._bbox.clear();
    for (const o of page.objs) this.objs.set(o.id, o);
    this.seq = page.seq;
  }

  _forget(id) { this._path.delete(id); this._bbox.delete(id); }

  apply(op) {
    switch (op.k) {
      case 'add':
        if (this.objs.has(op.id)) return false;
        this.objs.set(op.id, { ...op.d, id: op.id });
        return true;
      case 'update':
        if (!this.objs.has(op.id)) return false;
        this.objs.set(op.id, { ...op.d, id: op.id });
        this._forget(op.id);
        return true;
      case 'remove':
        this._forget(op.id);
        return this.objs.delete(op.id);
      case 'clear':
        if (!this.objs.size) return false;
        this.objs.clear(); this._path.clear(); this._bbox.clear();
        return true;
    }
    return false;
  }

  path(o) {
    let p = this._path.get(o.id);
    if (!p) { p = strokePath(o); this._path.set(o.id, p); }
    return p;
  }

  bbox(o) {
    let b = this._bbox.get(o.id);
    if (!b) { b = o.t === 'shape' ? shapeBBox(o, this.page || undefined) : strokeBBox(o); this._bbox.set(o.id, b); }
    return b;
  }

  // 점(x,y) 반지름 r 안에 닿는 획들
  hit(x, y, r) {
    const out = [];
    for (const o of this.objs.values()) {
      const b = this.bbox(o);
      if (o.t === 'shape') {
        if ((o.kind === 'ray' || o.kind === 'line' || !(x < b.x0 - r || x > b.x1 + r || y < b.y0 - r || y > b.y1 + r))
            && shapeHit(o, x, y, r, this.page || undefined)) out.push(o);
        continue;
      }
      if (x < b.x0 - r || x > b.x1 + r || y < b.y0 - r || y > b.y1 + r) continue;
      const rr = (r + o.w / 2) ** 2, p = o.pts;
      if (p.length === 3) {
        if ((p[0] - x) ** 2 + (p[1] - y) ** 2 <= rr) out.push(o);
        continue;
      }
      for (let i = 0; i + 3 < p.length; i += 3) {
        if (segDist2(x, y, p[i], p[i + 1], p[i + 3], p[i + 4]) <= rr) { out.push(o); break; }
      }
    }
    return out;
  }

  // 사각형 안에 점이 하나라도 있는 획들
  inRect(x0, y0, x1, y1) {
    const out = [];
    for (const o of this.objs.values()) {
      const b = this.bbox(o);
      if (b.x1 < x0 || b.x0 > x1 || b.y1 < y0 || b.y0 > y1) continue;
      if (o.t === 'shape') { if (shapeInRect(o, x0, y0, x1, y1)) out.push(o); continue; }
      const p = o.pts;
      for (let i = 0; i < p.length; i += 3) {
        if (p[i] >= x0 && p[i] <= x1 && p[i + 1] >= y0 && p[i + 1] <= y1) { out.push(o); break; }
      }
    }
    return out;
  }
}

// 부분 지우개: 원 안의 점을 빼고 남은 조각들. 변화가 없으면 null
export function splitStroke(o, x, y, r) {
  const p = o.pts, rr = r * r, pieces = [];
  let cur = [], cut = false;
  for (let i = 0; i < p.length; i += 3) {
    if ((p[i] - x) ** 2 + (p[i + 1] - y) ** 2 <= rr) {
      cut = true;
      if (cur.length) { pieces.push(cur); cur = []; }
    } else {
      cur.push(p[i], p[i + 1], p[i + 2]);
    }
  }
  if (!cut) return null;
  if (cur.length) pieces.push(cur);
  return pieces;
}
