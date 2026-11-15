// 화면 그리기: 확정 객체 캔버스 + 실시간 캔버스, 보기(확대·이동) 변환
import { strokePath } from './model.js';
import { drawShape, drawBackground, pageColor, inkColor } from './shapes.js';

const OUTSIDE = '#d9d9d4';
const WEB_W = 1600;   // 웹페이지는 모든 기기에서 같은 너비로 배치하고 크기만 맞춤(판서 위치가 기기마다 같도록)

export class Renderer {
  constructor(stage) {
    this.stage = stage;
    this.main = this._canvas('main');
    this.live = this._canvas('live');
    this.mctx = this.main.getContext('2d');
    this.lctx = this.live.getContext('2d');
    this.view = { s: 1, ox: 0, oy: 0, fit: 1 };
    this.pw = 3200; this.ph = 1800;
    this.board = null;
    this.hidden = new Set();       // 이동 중인 선택 객체는 실시간 캔버스에 그림
    this.overlay = null;           // 실시간 캔버스에 그릴 함수
    this._mainQueued = false; this._liveQueued = false;
    this._buildScroll();
    this.web = null; this.webInteract = false;
    const wt = document.createElement('button');
    wt.type = 'button'; wt.className = 'web-toggle'; wt.hidden = true;
    wt.onclick = () => this.setWebInteract(!this.webInteract);
    // 메뉴 막대(접속 기기 표시 왼쪽)에 두어 손이 닿게. 메뉴 막대가 없는 화면(학생 등)은 칠판 위에
    const peers = document.getElementById('peers');
    if (peers && peers.parentNode) { wt.classList.add('in-bar'); peers.parentNode.insertBefore(wt, peers); } else stage.appendChild(wt);
    this.webToggle = wt;
    new ResizeObserver(() => this.resize()).observe(stage);
    this.resize();
  }

  // 세로로 긴 페이지(PDF 쪽 등)용 스크롤 막대: 전자칠판에서 손가락으로 끌어 내림
  _buildScroll() {
    const bar = document.createElement('div');
    bar.className = 'vscroll'; bar.hidden = true;
    bar.innerHTML = '<button type="button" class="vs-btn" data-d="-1" aria-label="위로">▲</button><div class="vs-track"><i class="vs-thumb"></i></div><button type="button" class="vs-btn" data-d="1" aria-label="아래로">▼</button>';
    this.stage.appendChild(bar);
    this.vs = bar;
    const track = bar.querySelector('.vs-track'), thumb = bar.querySelector('.vs-thumb');
    let drag = null;
    thumb.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation(); thumb.setPointerCapture(e.pointerId);
      drag = { y: e.clientY, oy: this.view.oy };
    });
    thumb.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const total = this.ph * this.view.s, th = track.clientHeight;
      this.view.oy = drag.oy - (e.clientY - drag.y) * (total / th);
      this.clampView(); this.redraw();
    });
    const end = () => { drag = null; };
    thumb.addEventListener('pointerup', end); thumb.addEventListener('pointercancel', end);
    track.addEventListener('pointerdown', (e) => {          // 막대 빈 곳: 한 화면씩
      if (e.target !== track) return;
      const r = thumb.getBoundingClientRect();
      this.scrollPage(e.clientY < r.top ? -1 : 1);
    });
    bar.querySelectorAll('.vs-btn').forEach((b) => b.addEventListener('click', () => this.scrollPage(+b.dataset.d)));
  }

  // ── 실시간 웹캠 배경: 이 기기 카메라 영상을 캔버스 아래에(다른 기기에는 안내만) ──
  setLive(video, mirror = false) {
    if (this.camVideo && this.camVideo !== video) this.camVideo.remove();
    this.camVideo = video || null;
    if (video) {
      video.className = 'livebg';
      video.style.transform = mirror ? 'scaleX(-1)' : '';
      if (video.parentNode !== this.stage) this.stage.insertBefore(video, this.main);
    }
    this.requestMain();
  }

  _syncLive() {
    for (const el of [this.camVideo, this.under]) {
      if (!el) continue;
      const v = this.view, st = el.style;
      st.left = `${v.ox}px`; st.top = `${v.oy}px`;
      st.width = `${this.pw * v.s}px`; st.height = `${this.ph * v.s}px`;
    }
  }

  // ── 동영상 배경(유튜브·동영상 파일): video.js 가 만든 요소를 캔버스 아래 페이지 자리에 ──
  setUnder(el) {
    if (this.under && this.under !== el) this.under.remove();
    this.under = el || null;
    if (el && el.parentNode !== this.stage) this.stage.insertBefore(el, this.main);
    this.requestMain();
  }

  // ── 웹페이지 배경: 캔버스 아래에 iframe ──
  setWebInteract(on) {
    this.webInteract = !!on && !!this.web;
    this.stage.classList.toggle('web-interact', this.webInteract);
    this.webToggle.innerHTML = this.webInteract ? '✎ 판서<span class="wt-long">하기</span>' : '🖱 <span class="wt-long">웹페이지 </span>조작<span class="wt-long">하기</span>';
    this.webToggle.title = this.webInteract ? '판서하기' : '웹페이지 조작하기';
    this.webToggle.classList.toggle('on', this.webInteract);
  }

  _syncWeb() {
    const p = this.board && this.board.page;
    const url = p && p.bg_type === 'web' && p.bg_meta && p.bg_meta.url;
    if (!url) {
      if (this.web) { this.web.remove(); this.web = null; this.setWebInteract(false); }
      this.webToggle.hidden = true;
      return;
    }
    if (!this.web) {
      const f = document.createElement('iframe');
      f.className = 'webbg';
      f.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-presentation');
      f.setAttribute('allow', 'fullscreen; autoplay; encrypted-media; picture-in-picture');
      f.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
      this.stage.insertBefore(f, this.main);
      this.web = f;
      this.setWebInteract(false);
    }
    if (this.web.dataset.url !== url) {
      this.web.dataset.url = url;
      // 예전에 http 로 저장된 주소도 https 로(https 칠판 안에서 http 는 막힘)
      this.web.src = location.protocol === 'https:' ? url.replace(/^http:\/\//i, 'https://') : url;
    }
    const v = this.view, k = (this.pw * v.s) / WEB_W;
    this.web.style.width = `${WEB_W}px`;
    this.web.style.height = `${Math.round(WEB_W * this.ph / this.pw)}px`;
    this.web.style.transform = `translate(${v.ox}px, ${v.oy}px) scale(${k})`;
    this.webToggle.hidden = false;
  }

  scrollPage(dir) {
    this.view.oy -= dir * this.ch * 0.85;
    this.clampView(); this.redraw();
  }

  isTall() { return this.ph * this.view.s > this.ch + 2; }

  // 세로로 페이지가 화면보다 길 때만 위아래 끝을 넘지 않게
  clampView() {
    const v = this.view, total = this.ph * v.s, m = 24;
    if (total > this.ch) v.oy = Math.min(m, Math.max(this.ch - total - m, v.oy));
  }

  _syncScroll() {
    const tall = this.isTall();
    if (this.vs.hidden === tall) this.vs.hidden = !tall;
    if (!tall) return;
    const track = this.vs.querySelector('.vs-track'), th = track.clientHeight, total = this.ph * this.view.s;
    const h = Math.max(36, th * this.ch / total), top = Math.min(th - h, Math.max(0, (-this.view.oy / total) * th));
    const t = this.vs.querySelector('.vs-thumb');
    t.style.height = `${h}px`; t.style.transform = `translateY(${top}px)`;
  }

  _canvas(cls) {
    const c = document.createElement('canvas');
    c.className = 'layer ' + cls;
    this.stage.appendChild(c);
    return c;
  }

  resize() {
    const r = this.stage.getBoundingClientRect();
    this.cw = Math.max(1, r.width); this.ch = Math.max(1, r.height);
    this.dpr = window.devicePixelRatio || 1;
    for (const c of [this.main, this.live]) {
      c.width = Math.round(this.cw * this.dpr);
      c.height = Math.round(this.ch * this.dpr);
    }
    this.fit();
  }

  setPage(w, h) { this.pw = w; this.ph = h; this.fit(); }

  fit() {
    const sw = this.cw / this.pw, sh = this.ch / this.ph, fit = Math.min(sw, sh);
    // 세로로 긴 페이지는 너비에 맞추고 맨 위부터(스크롤)
    if (this.ph / this.pw > (this.ch / this.cw) * 1.25) {
      this.view = { s: sw, ox: 0, oy: 0, fit };
    } else {
      this.view = { s: fit, ox: (this.cw - this.pw * fit) / 2, oy: (this.ch - this.ph * fit) / 2, fit };
    }
    this.redraw();
  }

  zoomAt(cx, cy, factor) {
    const v = this.view;
    const s = Math.min(v.fit * 8, Math.max(v.fit * 0.5, v.s * factor));
    const k = s / v.s;
    v.ox = cx - (cx - v.ox) * k;
    v.oy = cy - (cy - v.oy) * k;
    v.s = s;
    this.redraw();
  }

  panBy(dx, dy) { this.view.ox += dx; this.view.oy += dy; this.clampView(); this.redraw(); }

  toPage(clientX, clientY) {
    const r = this.stage.getBoundingClientRect(), v = this.view;
    return { x: (clientX - r.left - v.ox) / v.s, y: (clientY - r.top - v.oy) / v.s };
  }

  toStage(clientX, clientY) {
    const r = this.stage.getBoundingClientRect();
    return { x: clientX - r.left, y: clientY - r.top };
  }

  redraw() { this.requestMain(); this.requestLive(); }

  requestMain() {
    if (this._mainQueued) return;
    this._mainQueued = true;
    requestAnimationFrame(() => { this._mainQueued = false; this.drawMain(); });
  }

  requestLive() {
    if (this._liveQueued) return;
    this._liveQueued = true;
    requestAnimationFrame(() => { this._liveQueued = false; this.drawLive(); });
  }

  _pageTransform(ctx) {
    const v = this.view, d = this.dpr;
    ctx.setTransform(d * v.s, 0, 0, d * v.s, d * v.ox, d * v.oy);
  }

  drawObj(ctx, o, path) {
    if (o.t === 'shape') { drawShape(ctx, o, this.board && this.board.page ? this.board.page : { w: this.pw, h: this.ph }); return; }
    ctx.globalAlpha = o.tool === 'hl' ? 0.35 : 1;
    ctx.fillStyle = inkColor(o.c, this.board && this.board.page);
    ctx.fill(path);
  }

  drawMain() {
    this._syncScroll();
    const ctx = this.mctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = OUTSIDE;
    ctx.fillRect(0, 0, this.cw, this.ch);
    this._pageTransform(ctx);
    this._syncWeb();
    this._syncLive();
    const web = !!this.web || !!this.camVideo || !!this.under;
    if (web) ctx.clearRect(0, 0, this.pw, this.ph);          // 아래의 웹페이지가 보이게
    else { ctx.fillStyle = pageColor(this.board && this.board.page); ctx.fillRect(0, 0, this.pw, this.ph); }
    if (!this.board) return;
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, this.pw, this.ph); ctx.clip();
    if (this.board.page && !web) drawBackground(ctx, this.board.page, () => this.requestMain());
    for (const o of this.board.objs.values()) {
      if (this.hidden.has(o.id)) continue;
      this.drawObj(ctx, o, o.t === 'shape' ? null : this.board.path(o));
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  // lives: Map<id, 진행 중인 획> (내 것 + 다른 기기 것)
  drawLive(lives = this.lives) {
    this.lives = lives;
    const ctx = this.lctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.live.width, this.live.height);
    this._pageTransform(ctx);
    if (lives) {
      ctx.save();
      ctx.beginPath(); ctx.rect(0, 0, this.pw, this.ph); ctx.clip();
      for (const o of lives.values()) {
        if (o.pts.length >= 3) this.drawObj(ctx, o, strokePath(o, false));
      }
      ctx.restore();
    }
    ctx.globalAlpha = 1;
    if (this.overlay) this.overlay(ctx, this);
  }
}

// 페이지를 이미지로 (스냅샷·썸네일·인쇄용). objs: 객체 배열 또는 Map.values()
export function renderPageCanvas(objs, pw, ph, outW, page = null) {
  const scale = outW / pw;
  const c = document.createElement('canvas');
  c.width = Math.round(outW); c.height = Math.round(ph * scale);
  const ctx = c.getContext('2d');
  const pg = page || { w: pw, h: ph };
  ctx.fillStyle = pageColor(pg);
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  drawBackground(ctx, pg);
  for (const o of objs) {
    if (o.t === 'shape') { drawShape(ctx, o, pg); continue; }
    if (o.t !== 'stroke' || !o.pts || o.pts.length < 3) continue;
    ctx.globalAlpha = o.tool === 'hl' ? 0.35 : 1;
    ctx.fillStyle = inkColor(o.c, pg);
    ctx.fill(strokePath(o));
  }
  ctx.globalAlpha = 1;
  return c;
}

export function canvasToWebp(c, quality = 0.85) {
  return new Promise((resolve) => {
    c.toBlob((b) => {
      if (!b) { resolve(null); return; }
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.readAsDataURL(b);
    }, 'image/webp', quality);
  });
}
