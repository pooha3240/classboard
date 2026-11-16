// 실시간으로 띄운 다른 탭(아이스크림 등)을 칠판 화면에서 손가락으로 눌러 조작
// 크롬 확장 'JMSchool 전자칠판 도우미'가 그 탭 안에서 누르기·끌기·스크롤·글자를 흉내 냄.
// 칠판 → (postMessage) → 확장 다리(bridge.js) → 확장 → 그 탭. 그 탭을 화면 공유로 받은 칠판만 탭의 표(token)를 알 수 있음
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let seq = 0;
const waits = new Map();
window.addEventListener('message', (e) => {
  if (e.source !== window || !e.data || !e.data.__ebxr) return;
  const w = waits.get(e.data.__ebxr.id);
  if (w) { waits.delete(e.data.__ebxr.id); w(e.data.__ebxr.res); }
});
function ext(op, o = {}, ms = 2500) {
  return new Promise((resolve) => {
    const id = `${Date.now()}.${++seq}`;
    waits.set(id, resolve);
    window.postMessage({ __ebx: { id, op, ...o } }, location.origin);
    setTimeout(() => { if (waits.has(id)) { waits.delete(id); resolve(null); } }, ms);
  });
}

// 도우미가 '이 탭을 칠판에 띄우기'로 보낸 탭(공유 중 막대 없음) → 등록된 받는 곳(media.js)으로
let castHandler = null;
export function onHelperCast(f) { castHandler = f; }
window.addEventListener('message', (e) => {
  if (e.source !== window || !e.data || !e.data.__ebxcast) return;
  const c = e.data.__ebxcast;
  if (castHandler && typeof c.streamId === 'string' && typeof c.secret === 'string') castHandler(c);
});
export function castEnded(secret) { if (secret) ext('castEnded', { secret }, 1000); }

// 확장이 깔려 있는지(다리 스크립트가 문서에 표시를 남김)
export function helperVersion() { return document.documentElement.getAttribute('data-ebx-helper'); }

export class RemoteTab {
  constructor({ renderer, toast }) {
    this.r = renderer; this.toast = toast;
    this.token = null; this.video = null; this.track = null;
    this.chain = Promise.resolve(); this.pend = null;
    this.ptrs = new Map(); this.pressing = false; this.pan = null;
    const pad = document.createElement('div');
    pad.className = 'remote-pad';
    this.pad = pad;
    pad.addEventListener('pointerdown', (e) => this._down(e));
    pad.addEventListener('pointermove', (e) => this._move(e));
    pad.addEventListener('pointerup', (e) => this._up(e));
    pad.addEventListener('pointercancel', (e) => this._up(e, true));
    pad.addEventListener('contextmenu', (e) => e.preventDefault());
    pad.addEventListener('wheel', (e) => {                       // 마우스 휠
      e.preventDefault();
      const p = this._norm(e), b = this._box();
      if (p && b) this._q({ k: 'wheel', ...p, ndx: e.deltaX / b.w, ndy: e.deltaY / b.h });
    }, { passive: false });
    this._buildBars();
    this._onHandle = () => this._readHandle();
  }

  get active() { return !!this.token; }

  // 화면 공유 트랙의 표 읽기(탭이 다른 페이지로 넘어가면 표가 바뀌고 capturehandlechange 가 옴)
  attach(track, video) {
    this.detach();
    this.track = track; this.video = video;
    if (track && track.addEventListener) track.addEventListener('capturehandlechange', this._onHandle);
    this._readHandle();
    return this.token;
  }

  // 도우미가 띄운 탭: 탭 번호에 묶인 비밀 값을 바로 받음(그 탭이 다른 페이지로 넘어가도 그대로)
  attachSecret(secret, track, video) {
    this.detach();
    this.track = track; this.video = video;
    this.token = secret; this.fixed = true;
    this.r.setRemote(this.pad);
    this.onChange && this.onChange();
    return this.token;
  }

  detach() {
    this.fixed = false;
    if (this.track && this.track.removeEventListener) this.track.removeEventListener('capturehandlechange', this._onHandle);
    clearTimeout(this._lostT);
    this.track = null; this.video = null; this.token = null;
    this.ptrs.clear(); this.pressing = false; this.pan = null;
    this._hideBars();
    this.r.setRemote(null);
    this.onChange && this.onChange();
  }

  _readHandle() {
    let h = null;
    try { h = this.track && this.track.getCaptureHandle ? this.track.getCaptureHandle() : null; } catch { h = null; }
    const tok = h && typeof h.handle === 'string' && h.handle.startsWith('ebx:') ? h.handle.slice(4) : null;
    const had = !!this.token;
    this.token = tok;
    this.origin = h && h.origin;
    // 그 탭이 다른 페이지로 넘어가는 동안 잠깐 표가 없어짐 → 조작 상태를 바로 끄지 않고 조금 기다림
    clearTimeout(this._lostT);
    if (tok) this.r.setRemote(this.pad);
    else if (had && this.track && this.track.readyState === 'live') {
      this._lostT = setTimeout(() => { if (!this.token) { this.r.setRemote(null); this.onChange && this.onChange(); } }, 5000);
    } else this.r.setRemote(null);
    if (!had && tok && this._waitedForReload) { this._waitedForReload = false; this.toast('이제 칠판에서 그 탭을 누를 수 있습니다. 실시간 막대의 \'🖱 조작\'을 누르세요', 4000); }
    if (!tok) this._hideBars();
    if (tok || !had) this.onChange && this.onChange();
  }

  // ── 좌표: 영상(object-fit: contain)이 실제로 그려진 칸 안의 0~1 비율 ──
  _box() {
    const v = this.video;
    if (!v || !v.videoWidth) return null;
    const r = this.pad.getBoundingClientRect();
    const rv = v.videoWidth / v.videoHeight, ra = r.width / r.height;
    let w = r.width, h = r.height;
    if (rv > ra) h = w / rv; else w = h * rv;
    return { x: r.left + (r.width - w) / 2, y: r.top + (r.height - h) / 2, w, h };
  }
  _norm(e) {
    const b = this._box();
    if (!b) return null;
    const nx = (e.clientX - b.x) / b.w, ny = (e.clientY - b.y) / b.h;
    if (nx < 0 || ny < 0 || nx > 1 || ny > 1) return null;
    return { nx, ny };
  }
  _centroid() {
    let x = 0, y = 0;
    for (const p of this.ptrs.values()) { x += p.x; y += p.y; }
    const n = this.ptrs.size || 1;
    return { clientX: x / n, clientY: y / n };
  }

  // ── 손가락 하나: 누르기·끌기, 두 손가락: 스크롤 ──
  _down(e) {
    e.preventDefault();
    try { this.pad.setPointerCapture(e.pointerId); } catch { /* 이미 뗌 */ }
    this.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.ptrs.size >= 2) {
      if (this.pressing) { this._q({ k: 'cancel', ...(this.last || { nx: 0, ny: 0 }) }); this.pressing = false; }
      this.pan = this._centroid();
      return;
    }
    const p = this._norm(e);
    if (!p) return;
    this.pressing = true; this.last = p;
    this._q({ k: 'down', ...p, touch: e.pointerType !== 'mouse' });
    this._dot(e.clientX, e.clientY);
  }

  _move(e) {
    const pt = this.ptrs.get(e.pointerId);
    if (pt) { pt.x = e.clientX; pt.y = e.clientY; }
    if (this.pan && this.ptrs.size >= 2) {
      const c = this._centroid(), b = this._box(), p = this._norm(c);
      if (b && p) this._q({ k: 'wheel', ...p, ndx: -(c.clientX - this.pan.clientX) / b.w, ndy: -(c.clientY - this.pan.clientY) / b.h });
      this.pan = c;
      return;
    }
    if (this.pressing && pt) {
      const b = this._box();
      if (!b) return;
      const p = { nx: Math.min(1, Math.max(0, (e.clientX - b.x) / b.w)), ny: Math.min(1, Math.max(0, (e.clientY - b.y) / b.h)) };
      this.last = p;
      this._q({ k: 'move', ...p, touch: e.pointerType !== 'mouse' });
    } else if (!pt && e.pointerType === 'mouse') {
      const p = this._norm(e);
      if (p) this._q({ k: 'hover', ...p });
    }
  }

  async _up(e, cancel = false) {
    this.ptrs.delete(e.pointerId);
    if (this.pan) { if (this.ptrs.size < 2) this.pan = null; return; }
    if (!this.pressing) return;
    this.pressing = false;
    const b = this._box();
    const p = b ? { nx: Math.min(1, Math.max(0, (e.clientX - b.x) / b.w)), ny: Math.min(1, Math.max(0, (e.clientY - b.y) / b.h)) } : this.last;
    const res = await this._q({ k: cancel ? 'cancel' : 'up', ...p, touch: e.pointerType !== 'mouse' });
    if (!cancel) this._result(res);
  }

  // ── 차례대로 보내기: 움직임·스크롤은 밀리면 마지막 것만(합쳐서) ──
  _q(ev) {
    if (!this.token) return Promise.resolve(null);
    if (ev.k === 'move' || ev.k === 'hover' || ev.k === 'wheel') {
      const p = this.pend;
      if (p && p.k === ev.k) {
        if (ev.k === 'wheel') { p.ndx += ev.ndx; p.ndy += ev.ndy; p.nx = ev.nx; p.ny = ev.ny; } else Object.assign(p, ev);
        return this.pendP;
      }
      const slot = { ...ev };
      this.pend = slot;
      this.pendP = this.chain = this.chain.then(() => { if (this.pend === slot) this.pend = null; return this._post(slot); });
      return this.pendP;
    }
    this.pend = null;
    return (this.chain = this.chain.then(() => this._post(ev)));
  }

  async _post(ev) {
    const tok = this.token;
    if (!tok) return null;
    const res = await ext('ctl', { token: tok, ev });
    if (!res) { this._warn('도우미가 답하지 않습니다. 크롬을 다시 열어 보세요'); return null; }
    if (res.err === 'notab') this._warn('그 탭을 찾지 못했습니다. 그 탭을 새로고침(F5)하거나 다시 띄워 주세요');
    else if (res.err === 'send' || res.err === 'page') this._warn('그 탭에 전하지 못했습니다. 그 탭을 새로고침(F5)해 보세요');
    return res;
  }
  _warn(m) { const t = Date.now(); if (t - (this._warned || 0) > 5000) { this._warned = t; this.toast(m, 4000); } }

  send(ev) { return this._q(ev).then((res) => { if (ev.k !== 'size') this._result(res); return res; }); }

  _dot(x, y) {
    const d = document.createElement('i');
    d.className = 'rt-dot';
    d.style.left = `${x}px`; d.style.top = `${y}px`;
    document.body.appendChild(d);
    setTimeout(() => d.remove(), 600);
  }

  // ── 그 탭에서 글자 칸·고르기 칸을 누르면 칠판에 입력 막대를 띄움(칠판의 화상 키보드로 씀) ──
  _buildBars() {
    const kb = document.createElement('div');
    kb.className = 'rt-kb'; kb.hidden = true;
    kb.innerHTML = `<input type="text" autocomplete="off" placeholder="그 탭 입력칸에 넣을 글자">
      <button type="button" class="primary" data-k="send">넣기</button>
      <button type="button" data-k="Backspace" title="한 글자 지우기">⌫</button>
      <button type="button" data-k="Enter" title="엔터(검색·확인)">↵</button>
      <button type="button" data-k="close" aria-label="닫기">✕</button>`;
    document.body.appendChild(kb);
    this.kb = kb;
    const inp = $('input', kb);
    const flush = () => { const s = inp.value; inp.value = ''; return s ? this.send({ k: 'text', s }) : Promise.resolve(); };
    kb.addEventListener('click', async (e) => {
      const k = e.target.closest('[data-k]')?.dataset.k;
      if (!k) return;
      if (k === 'close') { this._hideBars(); return; }
      if (k === 'send') { await flush(); inp.focus(); return; }
      if (k === 'Enter') { await flush(); }
      else if (k === 'Backspace' && inp.value) { inp.value = inp.value.slice(0, -1); inp.focus(); return; }
      this.send({ k: 'key', key: k });
      if (k !== 'Enter') inp.focus();
    });
    inp.addEventListener('keydown', async (e) => {
      if (e.isComposing) return;
      if (e.key === 'Enter') { e.preventDefault(); await flush(); this.send({ k: 'key', key: 'Enter' }); }
      else if (e.key === 'Backspace' && !inp.value) { e.preventDefault(); this.send({ k: 'key', key: 'Backspace' }); }
      else if (e.key === 'Escape') this._hideBars();
    });
    const sel = document.createElement('div');
    sel.className = 'rt-sel'; sel.hidden = true;
    document.body.appendChild(sel);
    this.sel = sel;
    sel.addEventListener('click', (e) => {
      const b = e.target.closest('[data-i]');
      if (b) { this.send({ k: 'select', i: +b.dataset.i }); sel.hidden = true; }
      else if (e.target.closest('[data-x]')) sel.hidden = true;
    });
  }

  openKeyboard(info = {}) {
    const inp = $('input', this.kb);
    inp.type = info.pw ? 'password' : 'text';
    inp.placeholder = info.ph ? `${info.ph} — 넣을 글자` : '그 탭 입력칸에 넣을 글자';
    this.sel.hidden = true;
    this.kb.hidden = false;
    setTimeout(() => inp.focus(), 0);
  }

  _result(res) {
    if (!res || !('focus' in res)) return;
    if (res.focus === 'text') { if (this.kb.hidden) this.openKeyboard(res); }
    else if (res.focus === 'select') {
      this.kb.hidden = true;
      this.sel.innerHTML = `<div class="rt-sel-h"><b>고르기</b><button type="button" data-x aria-label="닫기">✕</button></div>`
        + res.opts.map((o, i) => `<button type="button" data-i="${i}" class="${i === res.idx ? 'on' : ''}">${esc(o)}</button>`).join('');
      this.sel.hidden = false;
    } else this._hideBars();
  }

  _hideBars() { if (this.kb) this.kb.hidden = true; if (this.sel) this.sel.hidden = true; }
}
