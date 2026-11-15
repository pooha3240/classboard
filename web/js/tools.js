// 입력과 도구: 펜·형광펜·지우개 2종·선택 이동, 확대·이동, 되돌리기
import { newId, splitStroke } from './model.js';
import { shapeShift } from './shapes.js';

const LIVE_MS = 40;            // 진행 중인 획 전송 간격
const MAX_PTS = 4800;          // 서버 한도(5000)보다 조금 작게: 넘으면 획을 이어서 새로 시작
const ERASER_PX = 22;          // 지우개 반지름(화면 px)
const PINCH_WINDOW_MS = 160;   // 두 번째 손가락이 이 안에 닿으면 확대·이동

export const SIZES = { pen: [6, 12, 24], hl: [40, 64, 96] };
export const COLORS = ['#1d1d1b', '#ffffff', '#d7263d', '#1b5fd1', '#1e8a4c', '#f08a00', '#7b3fb5'];

export class Tools {
  constructor({ board, renderer, net, getPageId, onChange }) {
    this.board = board; this.r = renderer; this.net = net;
    this.getPageId = getPageId; this.onChange = onChange || (() => {});
    this.tool = 'pen';
    this.color = COLORS[0];
    this.sizeIdx = 1;
    this.penOnly = false;      // 펜이 감지되면 자동으로 켜짐: 손가락은 이동·확대만
    this.autoPenOnly = true;
    this.lives = new Map();    // 진행 중인 획(내 것 + 다른 기기 것)
    this.pointers = new Map(); // pointerId -> 상태
    this.undoStack = []; this.redoStack = [];
    this.histories = new Map();  // 페이지별 되돌리기 기록 (페이지 이동·재연결 후에도 유지)
    this.selection = new Set();
    this.cursor = null;
    this.math = null;          // MathTools (app.js 에서 연결)
    this.r.lives = this.lives;
    this.r.overlay = (ctx) => this._overlay(ctx);
    this._bind();
  }

  // ── 동작 적용과 되돌리기 ──
  commit(ops, undoOps) {
    for (const op of ops) this.board.apply(op);
    this.net.send(this.getPageId(), ops);
    if (undoOps) { this.undoStack.push({ redo: ops, undo: undoOps }); this.redoStack.length = 0; }
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.r.requestMain();
    this.onChange();
  }

  undo() {
    if (this.readOnly) return;
    const e = this.undoStack.pop();
    if (!e) return;
    this._replay(e.undo);
    this.redoStack.push(e);
    this.onChange();
  }

  redo() {
    if (this.readOnly) return;
    const e = this.redoStack.pop();
    if (!e) return;
    this._replay(e.redo);
    this.undoStack.push(e);
    this.onChange();
  }

  _replay(ops) {
    for (const op of ops) this.board.apply(op);
    this.net.send(this.getPageId(), ops);
    this.r.requestMain();
  }

  // 페이지를 바꾸거나 상태를 다시 받을 때 그 페이지의 기록으로 전환
  usePage(pageId) {
    if (!this.histories.has(pageId)) this.histories.set(pageId, { undo: [], redo: [] });
    const h = this.histories.get(pageId);
    this.undoStack = h.undo; this.redoStack = h.redo;
    this.selection.clear();
    this.onChange();
  }

  clearPage() {
    if (this.readOnly) return;
    const before = [...this.board.objs.values()];
    if (!before.length) return;
    this.commit([{ k: 'clear' }], before.map((o) => ({ k: 'add', id: o.id, d: strip(o) })));
  }

  deleteSelection() {
    if (this.readOnly) return;
    const objs = [...this.selection].map((id) => this.board.objs.get(id)).filter(Boolean);
    if (!objs.length) return;
    this.commit(objs.map((o) => ({ k: 'remove', id: o.id })), objs.map((o) => ({ k: 'add', id: o.id, d: strip(o) })));
    this.selection.clear();
    this.r.requestLive();
  }

  // ── 다른 기기에서 온 진행 중인 획 ──
  remoteLive(d) {
    let o = this.lives.get(d.sid);
    if (!o) {
      o = { id: d.sid, t: 'stroke', tool: d.tool, c: d.c, w: d.w, sp: d.sp, pts: [], remote: true };
      this.lives.set(d.sid, o);
    }
    o.pts.push(...d.pts);
    o.at = performance.now();
    this.r.requestLive();
  }

  remoteCommitted(id) { if (this.lives.delete(id)) this.r.requestLive(); }

  sweepLives() {
    const now = performance.now();
    for (const [id, o] of this.lives) if (o.remote && now - o.at > 4000) this.lives.delete(id);
  }

  // ── 포인터 ──
  _bind() {
    const el = this.r.live;
    el.addEventListener('pointerdown', (e) => this._down(e));
    el.addEventListener('pointermove', (e) => this._move(e));
    el.addEventListener('pointerup', (e) => this._up(e));
    el.addEventListener('pointercancel', (e) => this._up(e, true));
    el.addEventListener('pointerleave', () => { this.cursor = null; this.r.requestLive(); });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (this.r.isTall() && !e.ctrlKey) { this.r.panBy(-e.deltaX, -e.deltaY); return; }   // 긴 페이지: 휠 = 스크롤
      const p = this.r.toStage(e.clientX, e.clientY);
      this.r.zoomAt(p.x, p.y, Math.exp(-e.deltaY * 0.0015));
    }, { passive: false });
    setInterval(() => this.sweepLives(), 2000);
  }

  _down(e) {
    e.preventDefault();
    this.r.live.setPointerCapture(e.pointerId);
    if (this.readOnly) {                    // 합반 수업 보기 전용: 쓰지 않고 이동·확대만
      if (e.pointerType === 'mouse') this.pointers.set(e.pointerId, { kind: 'pan', x: e.clientX, y: e.clientY });
      else this._startGesture(e);
      return;
    }
    if (e.pointerType === 'pen' && this.autoPenOnly && !this.penOnly) { this.penOnly = true; this.onChange(); }

    // 마우스 오른쪽·가운데 버튼 = 이동
    if (e.pointerType === 'mouse' && e.button !== 0) {
      this.pointers.set(e.pointerId, { kind: 'pan', x: e.clientX, y: e.clientY });
      return;
    }
    const touches = [...this.pointers.values()].filter((p) => p.type === 'touch');
    if (e.pointerType === 'touch') {
      // 펜 전용 모드면 손가락은 항상 이동·확대
      if (this.penOnly) { this._startGesture(e); return; }
      // 첫 손가락이 방금 닿았다면 → 두 손가락 확대·이동
      const recent = touches.find((p) => p.kind !== 'gesture' && performance.now() - p.t0 < PINCH_WINDOW_MS);
      if (recent) { this._cancel(recent); this._startGesture(e, recent); return; }
      if (touches.some((p) => p.kind === 'gesture')) { this._startGesture(e); return; }
    }
    this._startTool(e);
  }

  _startGesture(e, other) {
    const p = { kind: 'gesture', type: e.pointerType, x: e.clientX, y: e.clientY, t0: performance.now() };
    this.pointers.set(e.pointerId, p);
    if (other) { other.kind = 'gesture'; other.x = other.lastX; other.y = other.lastY; }
  }

  _startTool(e) {
    const pt = this.r.toPage(e.clientX, e.clientY);
    const p = { kind: this.tool, type: e.pointerType, t0: performance.now(), lastX: e.clientX, lastY: e.clientY };
    this.pointers.set(e.pointerId, p);
    if (this.math) {
      // 펜을 자·삼각자 가장자리에 대면 곧게 그립니다. 그 밖에 도구를 누르면 옮기기·돌리기
      if ((this.tool === 'pen' || this.tool === 'hl') && !this.math.handleAt(pt)) p.edge = this.math.edgeAt(pt);
      if (!p.edge && this.math.down(p, pt, e)) { p.kind = 'math'; this.r.requestLive(); return; }
    }
    if (this.tool === 'pen' || this.tool === 'hl') {
      this._newStroke(p, e);
      this._addPoint(p, pt, e);
    } else if (this.tool === 'erase' || this.tool === 'erasePart') {
      p.removed = new Map(); p.added = new Set();
      this._erase(p, pt);
    } else if (this.tool === 'select') {
      const b = this._selBBox();
      if (b && pt.x >= b.x0 && pt.x <= b.x1 && pt.y >= b.y0 && pt.y <= b.y1) {
        p.kind = 'move'; p.start = pt; p.dx = 0; p.dy = 0;
        for (const id of this.selection) this.r.hidden.add(id);
        this.r.requestMain();
      } else {
        p.kind = 'rect'; p.start = pt; p.end = pt;
        this.selection.clear();
      }
      this.r.requestLive();
    }
  }

  _newStroke(p, e) {
    const tool = this.tool === 'hl' ? 'hl' : 'pen';
    p.obj = {
      id: newId(), t: 'stroke', tool, c: this.color, w: SIZES[tool][this.sizeIdx],
      sp: e.pointerType !== 'pen', pts: [],
    };
    p.sentIdx = 0; p.lastSend = 0;
    this.lives.set(p.obj.id, p.obj);
  }

  _addPoint(p, pt, e) {
    if (p.edge) pt = this.math.project(pt, p.edge);
    const o = p.obj, n = o.pts.length;
    const minD = 1 / this.r.view.s;                  // 화면 1px 보다 가까운 점은 건너뜀
    if (n >= 3) {
      const dx = pt.x - o.pts[n - 3], dy = pt.y - o.pts[n - 2];
      if (dx * dx + dy * dy < minD * minD) return;
    }
    const pr = e.pointerType === 'pen' ? Math.max(1, Math.round((e.pressure || 0.5) * 255)) : 128;
    o.pts.push(Math.round(pt.x), Math.round(pt.y), pr);
    if (o.pts.length >= MAX_PTS * 3) {               // 너무 긴 획은 끊어서 이어 그림
      this._finishStroke(p);
      this._newStroke(p, e);
      o.pts.length && p.obj.pts.push(...o.pts.slice(-3));
    }
  }

  _sendLive(p, force) {
    const now = performance.now();
    if (!force && now - p.lastSend < LIVE_MS) return;
    const o = p.obj;
    if (o.pts.length <= p.sentIdx) return;
    this.net.live({ page_id: this.getPageId(), sid: o.id, tool: o.tool, c: o.c, w: o.w, sp: o.sp,
                    pts: o.pts.slice(p.sentIdx) });
    p.sentIdx = o.pts.length; p.lastSend = now;
  }

  _finishStroke(p) {
    const o = p.obj;
    if (!o) return;
    this.lives.delete(o.id);
    if (o.pts.length >= 3) {
      const d = strip(o);
      this.commit([{ k: 'add', id: o.id, d }], [{ k: 'remove', id: o.id }]);
    }
    p.obj = null;
    this.r.requestLive();
  }

  _erase(p, pt) {
    const r = ERASER_PX / this.r.view.s;
    let hits = this.board.hit(pt.x, pt.y, r);
    if (this.canEdit) hits = hits.filter(this.canEdit);       // 학생: 자기가 그린 것만
    if (!hits.length) return;
    const ops = [];
    for (const o of hits) {
      if (this.tool === 'erase') {
        ops.push({ k: 'remove', id: o.id });
        this._track(p, o);
      } else if (o.t === 'shape') {             // 도형은 부분 지우개로도 통째로 지움
        ops.push({ k: 'remove', id: o.id });
        this._track(p, o);
      } else {
        const pieces = splitStroke(o, pt.x, pt.y, r + o.w / 2);
        if (!pieces) continue;
        ops.push({ k: 'remove', id: o.id });
        this._track(p, o);
        for (const pts of pieces) {
          const id = newId();
          ops.push({ k: 'add', id, d: { ...strip(o), pts } });
          p.added.add(id);
        }
      }
    }
    if (!ops.length) return;
    for (const op of ops) this.board.apply(op);
    this.net.send(this.getPageId(), ops);
    this.r.requestMain();
  }

  // 지우개 한 번(누르고 떼기)을 되돌리기 하나로 묶기 위한 기록
  _track(p, o) {
    if (p.added.has(o.id)) p.added.delete(o.id);           // 이번에 만든 조각을 또 자른 경우
    else if (!p.removed.has(o.id)) p.removed.set(o.id, strip(o));
  }

  _move(e) {
    const p = this.pointers.get(e.pointerId);
    if (!p) {
      if (this.tool === 'erase' || this.tool === 'erasePart') {
        this.cursor = this.r.toStage(e.clientX, e.clientY);
        this.r.requestLive();
      }
      return;
    }
    e.preventDefault();
    if (p.kind === 'pan') {
      this.r.panBy(e.clientX - p.x, e.clientY - p.y);
      p.x = e.clientX; p.y = e.clientY;
      return;
    }
    if (p.kind === 'gesture') { this._gesture(e, p); return; }
    if (p.kind === 'math') { this.math.move(p, this.r.toPage(e.clientX, e.clientY), e); this.r.requestLive(); return; }
    p.lastX = e.clientX; p.lastY = e.clientY;
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    const list = evs.length ? evs : [e];

    if (p.kind === 'pen' || p.kind === 'hl') {
      for (const ce of list) this._addPoint(p, this.r.toPage(ce.clientX, ce.clientY), ce);
      this._sendLive(p);
      this.r.requestLive();
    } else if (p.kind === 'erase' || p.kind === 'erasePart') {
      for (const ce of list) this._erase(p, this.r.toPage(ce.clientX, ce.clientY));
      this.cursor = this.r.toStage(e.clientX, e.clientY);
      this.r.requestLive();
    } else if (p.kind === 'rect') {
      p.end = this.r.toPage(e.clientX, e.clientY);
      this.r.requestLive();
    } else if (p.kind === 'move') {
      const pt = this.r.toPage(e.clientX, e.clientY);
      p.dx = pt.x - p.start.x; p.dy = pt.y - p.start.y;
      this.r.requestLive();
    }
  }

  _gesture(e, p) {
    const gs = [...this.pointers.entries()].filter(([, q]) => q.kind === 'gesture');
    const prev = { x: p.x, y: p.y };
    p.x = e.clientX; p.y = e.clientY;
    if (gs.length >= 2) {
      const [a, b] = gs.map(([, q]) => q);
      const other = a === p ? b : a;
      const before = Math.hypot(prev.x - other.x, prev.y - other.y);
      const after = Math.hypot(p.x - other.x, p.y - other.y);
      const mid = this.r.toStage((p.x + other.x) / 2, (p.y + other.y) / 2);
      if (before > 10) this.r.zoomAt(mid.x, mid.y, after / before);
      this.r.panBy((p.x - prev.x) / 2, (p.y - prev.y) / 2);
    } else {
      this.r.panBy(p.x - prev.x, p.y - prev.y);
    }
  }

  _cancel(p) {
    if (p.obj) { this.lives.delete(p.obj.id); p.obj = null; this.r.requestLive(); }
  }

  _up(e, cancelled) {
    const p = this.pointers.get(e.pointerId);
    this.pointers.delete(e.pointerId);
    if (!p) return;
    if (p.kind === 'math') {
      if (!cancelled) this.math.up(p, this.r.toPage(e.clientX, e.clientY), e);
      this.r.requestLive();
      return;
    }
    if (p.kind === 'pen' || p.kind === 'hl') {
      if (cancelled) this._cancel(p); else { this._sendLive(p, true); this._finishStroke(p); }
    } else if (p.kind === 'erase' || p.kind === 'erasePart') {
      if (p.removed.size || p.added.size) {
        const redo = [...p.removed.keys()].map((id) => ({ k: 'remove', id }))
          .concat([...p.added].map((id) => ({ k: 'add', id, d: strip(this.board.objs.get(id)) })));
        const undo = [...p.added].map((id) => ({ k: 'remove', id }))
          .concat([...p.removed.entries()].map(([id, d]) => ({ k: 'add', id, d })));
        this.undoStack.push({ redo, undo }); this.redoStack.length = 0;
        this.onChange();
      }
    } else if (p.kind === 'rect') {
      const a = p.start, b = p.end;
      for (const o of this.board.inRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y))) {
        if (this.canEdit && !this.canEdit(o)) continue;
        this.selection.add(o.id);
      }
      this.onChange();
    } else if (p.kind === 'move') {
      for (const id of this.selection) this.r.hidden.delete(id);
      const dx = Math.round(p.dx), dy = Math.round(p.dy);
      if (dx || dy) {
        const ops = [], undo = [];
        for (const id of this.selection) {
          const o = this.board.objs.get(id);
          if (!o) continue;
          undo.push({ k: 'update', id, d: strip(o) });
          ops.push({ k: 'update', id, d: o.t === 'shape' ? strip(shapeShift(o, dx, dy)) : { ...strip(o), pts: shift(o.pts, dx, dy) } });
        }
        this.commit(ops, undo);
      } else {
        this.r.requestMain();
      }
    }
    this.r.requestLive();
  }

  // ── 실시간 캔버스 위 표시 ──
  _selBBox() {
    let b = null;
    for (const id of this.selection) {
      const o = this.board.objs.get(id);
      if (!o) continue;
      const q = this.board.bbox(o);
      b = b ? { x0: Math.min(b.x0, q.x0), y0: Math.min(b.y0, q.y0), x1: Math.max(b.x1, q.x1), y1: Math.max(b.y1, q.y1) } : { ...q };
    }
    return b;
  }

  _overlay(ctx) {
    const s = this.r.view.s;
    if (this.math) this.math.overlay(ctx, this.pointers);
    const mv = [...this.pointers.values()].find((p) => p.kind === 'move');
    if (mv) {
      ctx.save();
      ctx.translate(mv.dx, mv.dy);
      for (const id of this.selection) {
        const o = this.board.objs.get(id);
        if (o) this.r.drawObj(ctx, o, o.t === 'shape' ? null : this.board.path(o));
      }
      ctx.restore();
      ctx.globalAlpha = 1;
    }
    const rect = [...this.pointers.values()].find((p) => p.kind === 'rect');
    ctx.lineWidth = 1.5 / s;
    ctx.setLineDash([6 / s, 4 / s]);
    ctx.strokeStyle = '#1b5fd1';
    if (rect) {
      const a = rect.start, b = rect.end;
      ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    }
    const sb = this._selBBox();
    if (sb && !rect) {
      const dx = mv ? mv.dx : 0, dy = mv ? mv.dy : 0;
      ctx.fillStyle = 'rgba(27,95,209,0.06)';
      ctx.fillRect(sb.x0 + dx, sb.y0 + dy, sb.x1 - sb.x0, sb.y1 - sb.y0);
      ctx.strokeRect(sb.x0 + dx, sb.y0 + dy, sb.x1 - sb.x0, sb.y1 - sb.y0);
    }
    ctx.setLineDash([]);
    if (this.cursor && (this.tool === 'erase' || this.tool === 'erasePart')) {
      ctx.setTransform(this.r.dpr, 0, 0, this.r.dpr, 0, 0);
      ctx.beginPath();
      ctx.arc(this.cursor.x, this.cursor.y, ERASER_PX, 0, Math.PI * 2);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = this.tool === 'erase' ? '#d7263d' : '#6b6b66';
      ctx.stroke();
    }
  }
}

function strip(o) {
  const { id, remote, at, ...d } = o;      // eslint-disable-line no-unused-vars
  return d;
}

function shift(pts, dx, dy) {
  const out = pts.slice();
  for (let i = 0; i < out.length; i += 3) { out[i] += dx; out[i + 1] += dy; }
  return out;
}
