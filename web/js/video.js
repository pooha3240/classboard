// 동영상 배경(유튜브·올린 동영상 파일). 영상은 화면을 보내지 않고 각 기기가 직접 재생합니다.
// 진행 기기(교사)가 재생·멈춤·위치를 바꾸면 서버가 {재생 중?, 위치, 시각}만 같은 방에 알리고,
// 모든 기기는 서버 시계 기준으로 '지금 있어야 할 위치'를 계산해 따라갑니다(늦게 들어온 반도 그 자리부터).
const $ = (s, el = document) => el.querySelector(s);
const YT_HOST = 'https://www.youtube-nocookie.com';
const fmt = (t) => {
  t = Math.max(0, Math.floor(t || 0));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(s).padStart(2, '0')}`;
};

export class VideoBg {
  constructor({ net, renderer, toast, canControl, audible }) {
    this.net = net; this.r = renderer; this.toast = toast || (() => {});
    this.canControl = canControl || (() => false);
    this.audible = audible || (() => true);
    this.page = null; this.el = null; this.key = null; this.src = null;
    this.play = null; this.offset = 0;          // offset: 서버 시계 − 이 기기 시계(ms)
    this.yt = { t: 0, at: 0, dur: 0, state: -1, ready: false };
    this.userMute = null;                       // 이 기기에서 직접 고른 소리 켜기/끄기(null = 자동)
    this.blocked = false;                       // 브라우저가 소리 있는 재생을 막아서 소리 없이 트는 중
    this._seekAt = 0; this._playAt = 0; this._endSent = false;
    this._buildBar();
    this._buildUnmute();
    window.addEventListener('message', (e) => this._ytMsg(e));
    net.addEventListener('video:state', (e) => {
      const d = e.detail;
      if (this.page && d.page_id === this.page.id) { this.page.play = d.play; this.setPlay(d.play); }
    });
    setInterval(() => this._apply(), 1000);
    setInterval(() => { if (!this.bar.hidden) this._syncBar(); }, 300);
  }

  // ── 페이지 ──
  onPage(page) {
    this.page = page;
    const m = page && page.bg_type === 'video' ? (page.bg_meta || {}) : null;
    const key = m ? (m.src === 'yt' ? `yt:${m.yt}` : `file:${m.asset}`) : null;
    if (key !== this.key) { this._teardown(); if (key) this._create(m, page.bg_url); this.key = key; }
    this.bar.hidden = !key || !this.canControl();
    if (key) this.setPlay(page.play || null);
  }

  _teardown() {
    if (this.el) {
      if (this.src === 'file') { try { this.el.pause(); this.el.removeAttribute('src'); this.el.load(); } catch { /* 무시 */ } }
      this.r.setUnder(null);
    }
    this.el = null; this.key = null; this.src = null; this.play = null; this.blocked = false; this.userMute = null;
    this._lastSound = undefined;
    this.yt = { t: 0, at: 0, dur: 0, state: -1, ready: false };
    this.unmute.hidden = true;
  }

  _create(m, url) {
    this.src = m.src;
    this.start = m.src === 'yt' ? (m.start || 0) : 0;
    if (m.src === 'yt') {
      const f = document.createElement('iframe');
      f.className = 'videobg';
      f.setAttribute('allow', 'autoplay; encrypted-media');
      f.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
      f.src = `${YT_HOST}/embed/${m.yt}?enablejsapi=1&controls=0&disablekb=1&rel=0&playsinline=1&iv_load_policy=3&fs=0`
        + `${this.start ? `&start=${this.start}` : ''}&origin=${encodeURIComponent(location.origin)}`;
      f.addEventListener('load', () => this._ytHello());
      this.el = f;
    } else {
      const v = document.createElement('video');
      v.className = 'videobg';
      v.playsInline = true; v.preload = 'auto'; v.src = url;
      v.addEventListener('loadedmetadata', () => this._apply());
      v.addEventListener('error', () => this.toast('동영상을 재생할 수 없습니다. 이 기기에서 열 수 없는 형식일 수 있습니다(MP4·H.264 권장)', 5000));
      this.el = v;
    }
    this.r.setUnder(this.el);
  }

  // ── 유튜브: 외부 스크립트 없이 iframe 과 메시지로 조작(enablejsapi) ──
  _ytCmd(func, args = []) {
    if (this.src === 'yt' && this.el && this.el.contentWindow) {
      this.el.contentWindow.postMessage(JSON.stringify({ event: 'command', func, args }), YT_HOST);
    }
  }

  _ytHello() {
    let n = 0;
    const hi = () => {
      if (this.src !== 'yt' || !this.el || this.yt.ready || n++ > 20) return;
      this.el.contentWindow.postMessage(JSON.stringify({ event: 'listening', id: 1, channel: 'widget' }), YT_HOST);
      setTimeout(hi, 400);
    };
    hi();
  }

  _ytMsg(e) {
    if (this.src !== 'yt' || !this.el || e.source !== this.el.contentWindow || e.origin !== YT_HOST) return;
    let d; try { d = typeof e.data === 'string' ? JSON.parse(e.data) : e.data; } catch { return; }
    if (!d || typeof d !== 'object') return;
    if (d.event === 'onReady' || d.event === 'initialDelivery') { this.yt.ready = true; this._apply(true); }
    const info = d.info;
    if (!info || typeof info !== 'object') return;
    this.yt.ready = true;
    if (typeof info.currentTime === 'number') { this.yt.t = info.currentTime; this.yt.at = performance.now(); }
    if (typeof info.duration === 'number' && info.duration > 0) this.yt.dur = info.duration;
    if (typeof info.playerState === 'number') {
      const was = this.yt.state;
      this.yt.state = info.playerState;
      if (info.playerState === 0 && was !== 0) this._ended();
    }
  }

  // ── 지금 이 기기 상태 ──
  _dur() { return this.src === 'file' ? (this.el && isFinite(this.el.duration) ? this.el.duration : 0) : this.yt.dur; }

  _cur() {
    if (!this.el) return 0;
    if (this.src === 'file') return this.el.currentTime;
    const run = this.yt.state === 1 ? (performance.now() - this.yt.at) / 1000 : 0;
    return this.yt.t + run;
  }

  _isPlaying() {
    if (!this.el) return false;
    return this.src === 'file' ? !this.el.paused && !this.el.ended : this.yt.state === 1 || this.yt.state === 3;
  }

  _serverNow() { return (Date.now() + this.offset) / 1000; }

  expected() {
    const p = this.play;
    if (!p) return this.start || 0;
    let t = p.playing ? p.pos + (this._serverNow() - p.at) : p.pos;
    const d = this._dur();
    if (d) t = Math.min(t, d);
    return Math.max(0, t);
  }

  setPlay(play) {
    if (play && typeof play.now === 'number') this.offset = play.now * 1000 + (this.net.rtt || 0) / 2 - Date.now();
    this.play = play || null;
    if (!play || !play.playing) this._endSent = false;
    this._apply(true);
  }

  _wantSound() { return this.userMute !== null ? !this.userMute : !!this.audible(); }

  // 서버 상태에 맞추기: 1초마다, 그리고 상태가 바뀔 때
  _apply(force = false) {
    if (!this.el || (this.src === 'yt' && !this.yt.ready)) return;
    if (this.src === 'file' && this.el.readyState < 1) return;
    const want = this.expected(), cur = this._cur(), playing = !!(this.play && this.play.playing);
    const d = this._dur(), atEnd = d && want >= d - 0.3;
    const settling = performance.now() - this._seekAt < 2500;
    this._sound();
    if (playing && !atEnd) {
      if (!this._isPlaying()) this._doPlay();
      const tol = this.src === 'yt' ? 1.5 : 0.8;
      if ((force || !settling) && Math.abs(cur - want) > tol) this._seek(want);
    } else {
      if (this._isPlaying()) this._doPause();
      if ((force || !settling) && Math.abs(cur - want) > 0.3) this._seek(want);
      if (playing && atEnd) this._ended();
    }
  }

  _seek(t) {
    this._seekAt = performance.now();
    if (this.src === 'file') { try { this.el.currentTime = t; } catch { /* 무시 */ } }
    else {
      this._ytCmd('seekTo', [t, true]);
      // 처음(재생 전) 상태에서 seekTo 를 하면 유튜브가 재생을 시작함 → 멈춘 상태여야 하면 바로 멈춤
      if (!(this.play && this.play.playing)) this._ytCmd('pauseVideo');
      this.yt.t = t; this.yt.at = performance.now();
    }
  }

  _doPlay() {
    this._playAt = performance.now();
    if (this.src === 'file') {
      const v = this.el;
      v.muted = !this._wantSound() || this.blocked;
      v.play().catch((e) => {
        if (e && e.name === 'NotAllowedError' && !v.muted) {   // 소리 있는 자동 재생이 막힘 → 소리 없이 틀고 '소리 켜기'
          this.blocked = true; v.muted = true; this.unmute.hidden = false;
          v.play().catch(() => {});
        }
      });
    } else {
      this._ytCmd(this._wantSound() && !this.blocked ? 'unMute' : 'mute');
      this._ytCmd('playVideo');
      // 유튜브는 막혀도 알려 주지 않음: 잠시 뒤에도 안 돌고 있으면 소리 없이 다시
      setTimeout(() => {
        if (this.src !== 'yt' || !this.play || !this.play.playing || this._isPlaying() || this.blocked) return;
        if (!this._wantSound()) return;
        this.blocked = true; this.unmute.hidden = false;
        this._ytCmd('mute'); this._ytCmd('playVideo');
      }, 2500);
    }
  }

  _doPause() {
    if (this.src === 'file') this.el.pause();
    else this._ytCmd('pauseVideo');
  }

  _sound() {
    if (!this.el) return;
    const on = this._wantSound() && !this.blocked;
    if (this.src === 'file') { if (this.el.muted === on) this.el.muted = !on; }
    else if (this._lastSound !== on) this._ytCmd(on ? 'unMute' : 'mute');
    this._lastSound = on;
    this._syncBar();
  }

  _ended() {
    // 끝까지 재생됨: 진행 기기가 '끝 위치에서 멈춤'으로 알림(여러 대가 보내도 같은 결과)
    if (!this.canControl() || this._endSent || !this.play || !this.play.playing) return;
    this._endSent = true;
    this.send('pause', this._dur() || this.expected());
  }

  // ── 조작(진행 기기) ──
  async send(action, pos) {
    if (!this.page) return;
    pos = Math.max(0, Math.min(pos, this._dur() || 86400));
    const playing = action === 'play' || (action === 'seek' && !!(this.play && this.play.playing));
    const now = this._serverNow();
    this.setPlay({ playing, pos, at: now, now });            // 먼저 이 기기에 반영
    const r = await this.net.call('video:ctl', { page_id: this.page.id, action, pos }).catch(() => null);
    if (!r || !r.ok) this.toast('다른 기기에 알리지 못했습니다' + (r && r.error ? ` (${r.error})` : ''));
  }

  toggle() {
    const playing = !!(this.play && this.play.playing);
    let t = this.expected();
    const d = this._dur();
    if (!playing && d && t >= d - 0.5) t = 0;                // 끝났으면 처음부터
    this.send(playing ? 'pause' : 'play', t);
  }

  _buildBar() {
    const el = document.createElement('div');
    el.className = 'video-bar'; el.hidden = true;
    el.innerHTML = `
      <button type="button" data-v="back" title="10초 뒤로" aria-label="10초 뒤로">⏪</button>
      <button type="button" data-v="play" class="vb-play" aria-label="재생">▶</button>
      <button type="button" data-v="fwd" title="10초 앞으로" aria-label="10초 앞으로">⏩</button>
      <input type="range" class="vb-seek" min="0" max="1" step="0.1" value="0" aria-label="재생 위치">
      <span class="vb-time">0:00</span>
      <button type="button" data-v="sound" class="vb-sound" title="이 기기 소리" aria-label="이 기기 소리">🔊</button>`;
    document.body.appendChild(el);
    this.bar = el;
    el.addEventListener('pointerdown', (e) => e.stopPropagation());
    el.onclick = (e) => {
      const a = e.target.closest('[data-v]')?.dataset.v;
      if (a === 'play') this.toggle();
      else if (a === 'back') this.send('seek', this.expected() - 10);
      else if (a === 'fwd') this.send('seek', this.expected() + 10);
      else if (a === 'sound') { this.userMute = this._wantSound(); this.blocked = false; this.unmute.hidden = true; this._sound(); if (this.play && this.play.playing) this._doPlay(); }
    };
    const seek = $('.vb-seek', el);
    seek.addEventListener('input', () => { this._dragging = true; $('.vb-time', el).textContent = `${fmt(+seek.value)} / ${fmt(this._dur())}`; });
    seek.addEventListener('change', () => { this._dragging = false; this.send('seek', +seek.value); });
  }

  _syncBar() {
    if (!this.bar || this.bar.hidden) return;
    const d = this._dur(), t = this.expected(), playing = !!(this.play && this.play.playing);
    const b = $('.vb-play', this.bar);
    b.textContent = playing ? '⏸' : '▶'; b.setAttribute('aria-label', playing ? '멈춤' : '재생');
    const seek = $('.vb-seek', this.bar);
    if (!this._dragging) {
      seek.max = String(d || 1); seek.value = String(Math.min(t, d || 1)); seek.disabled = !d;
      $('.vb-time', this.bar).textContent = `${fmt(t)} / ${d ? fmt(d) : '--:--'}`;
    }
    const on = this._wantSound() && !this.blocked;
    $('.vb-sound', this.bar).textContent = on ? '🔊' : '🔇';
    $('.vb-sound', this.bar).title = on ? '이 기기 소리 끄기' : '이 기기 소리 켜기';
  }

  _buildUnmute() {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'video-unmute'; b.hidden = true;
    b.textContent = '🔊 동영상 소리 켜기';
    b.onclick = () => {
      this.blocked = false; this.userMute = false; b.hidden = true;
      if (this.src === 'file') { this.el.muted = false; this.el.play().catch(() => { this.blocked = true; b.hidden = false; }); }
      this._sound();
    };
    document.body.appendChild(b);
    this.unmute = b;
  }
}
