// 서버 연결과 동작 전송 대기열 — classboard (Cloudflare 학급 DO, 순수 WebSocket)
//
// jmschool판 net.js 와 같은 모양(API)을 유지합니다. 다른 화면 모듈은 그대로 씁니다.
// - 동작은 40ms 묶음으로 보냅니다. 응답(ack) 전까지 pending 에 남겨 두고, 재연결 후 다시 보냅니다.
// - 객체 ID 가 같으면 서버가 중복을 무시하므로 두 번 들어가지 않습니다.
// 메시지: 기기→서버 {c?: 번호, e: 이벤트, d}, 서버→기기 {a: 번호, d} 또는 {e: 이벤트, d}
// 연결 유지: 15초마다 "ping"(서버 자동 응답 "pong", 요청 수에 잡히지 않음) → 왕복 시간(rtt)도 여기서 잼
import { newId } from './model.js';

const FLUSH_MS = 40;
const MAX_BATCH = 200;
// 교사 토큰과 학생 토큰은 따로 둡니다(같은 기기에서 둘 다 열어 볼 수 있게).
const keyOf = (who) => (who === 'student' ? 'eboard.stoken' : 'eboard.token');

export function savedToken(who = 'teacher') {
  try {
    const t = JSON.parse(localStorage.getItem(keyOf(who)) || 'null');
    return t && t.exp * 1000 > Date.now() + 60_000 ? t : null;
  } catch { return null; }
}
export function saveToken(t, who = 'teacher') { try { localStorage.setItem(keyOf(who), JSON.stringify(t)); } catch { /* 저장 불가 */ } }
export function clearToken(who = 'teacher') { try { localStorage.removeItem(keyOf(who)); } catch { /* 무시 */ } }

export class Net extends EventTarget {
  constructor(device, deviceKey = null) {
    super();
    this.device = device;
    this.deviceKey = deviceKey;   // 등록된 전자칠판이면 기기 키로 토큰을 받음
    this.deviceInfo = null;
    this.cid = newId();
    this.ws = null;
    this.outbox = [];          // 아직 보내지 않은 동작 {page_id, op}
    this.pending = new Map();  // bid -> batch (응답 대기)
    this.calls = new Map();    // 호출 번호 -> {resolve, reject, timer}
    this.callNo = 0;
    this.bid = 0;
    this._timer = null;
    this.rtt = null;
    this._stopped = false;
    this._retry = 0;
    this._pingAt = 0;
    const self = this;
    // 다른 모듈이 net.socket.emit / disconnect 를 쓰므로 같은 모양을 둡니다.
    this.socket = {
      get connected() { return self.connected; },
      emit: (ev, data) => self._send({ e: ev, d: data }),
      volatile: { emit: (ev, data) => { if (self.ws && self.ws.bufferedAmount < 64 * 1024) self._send({ e: ev, d: data }); } },
      disconnect: () => { self._stopped = true; if (self.ws) self.ws.close(1000); },
    };
  }

  async token() {
    if (this.deviceKey) {
      const r = await fetch('/eboard-api/auth/device/token', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: this.deviceKey }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        const e = new Error((j.detail && j.detail.message) || '기기 토큰 발급 실패');
        e.code = (j.detail && j.detail.error) || r.status;
        throw e;
      }
      this.deviceInfo = j.device;
      this.lastToken = j.token;
      return j.token;
    }
    const who = this.device === 'student' ? 'student' : 'teacher';
    const t = savedToken(who);
    if (!t) {
      const e = new Error('로그인이 필요합니다');
      e.code = 'not_logged_in';
      throw e;
    }
    this.lastToken = t.token;
    return t.token;
  }

  connect() {
    this._stopped = false;
    this._open();
    setInterval(() => this.ping(), 15000);
  }

  async _open() {
    if (this._stopped) return;
    let token;
    try { token = await this.token(); }
    catch (e) { this._emit('auth-error', e); return; }
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws?device=${encodeURIComponent(this.device)}&token=${encodeURIComponent(token)}`);
    this.ws = ws;
    let opened = false;
    ws.onopen = () => { opened = true; };
    ws.onmessage = (ev) => {
      if (ev.data === 'pong') {
        if (this._pingAt) { this.rtt = Math.round(performance.now() - this._pingAt); this._pingAt = 0; this._emit('rtt', this.rtt); }
        return;
      }
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (typeof m.a === 'number') {
        const c = this.calls.get(m.a);
        if (c) { clearTimeout(c.timer); this.calls.delete(m.a); c.resolve(m.d); }
        return;
      }
      if (m.e === 'hello') {
        this._retry = 0;
        this._connected = true;
        this._emit('connect');
        this._emit('hello', m.d);
        this.ping();                       // 연결 직후 왕복 시간을 한 번 잼
        return;
      }
      if (m.e === 'auth-error') {
        const e = new Error(m.d && m.d.error);
        e.code = m.d && m.d.error;
        const who = this.device === 'student' ? 'student' : 'teacher';
        if (['not_logged_in', 'bad_signature', 'expired', 'code_changed'].includes(e.code)) { clearToken(who); if (e.code !== 'code_changed') e.code = 'not_logged_in'; }
        this._stopped = true;
        this._emit('auth-error', e);
        return;
      }
      if (m.e) this._emit(m.e, m.d);
    };
    ws.onclose = () => {
      const was = this._connected;
      this._connected = false;
      for (const [, c] of this.calls) { clearTimeout(c.timer); c.reject(new Error('offline')); }
      this.calls.clear();
      if (was) this._emit('disconnect', 'closed');
      else if (!opened) this._emit('connect-error', new Error('connect failed'));
      if (this._stopped) return;
      const delay = Math.min(5000, 500 * 2 ** this._retry++) + Math.random() * 300;
      setTimeout(() => this._open(), delay);
    };
  }

  _emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  get connected() { return !!(this._connected && this.ws && this.ws.readyState === 1); }

  _send(obj) {
    if (!this.connected) return false;
    try { this.ws.send(JSON.stringify(obj)); return true; } catch { return false; }
  }

  call(ev, data, timeout = 8000) {
    if (!this.connected) return Promise.reject(new Error('offline'));
    const c = ++this.callNo;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.calls.delete(c); reject(new Error('timeout')); }, timeout);
      this.calls.set(c, { resolve, reject, timer });
      if (!this._send({ c, e: ev, d: data })) { clearTimeout(timer); this.calls.delete(c); reject(new Error('offline')); }
    });
  }

  ping() {
    if (!this.connected) return;
    this._pingAt = performance.now();
    try { this.ws.send('ping'); } catch { /* 다음 주기에 */ }
  }

  // ── 동작 전송 ──
  send(pageId, ops) {
    for (const op of ops) this.outbox.push({ page_id: pageId, op });
    if (!this._timer) this._timer = setTimeout(() => this.flush(), FLUSH_MS);
  }

  flush() {
    this._timer = null;
    if (!this.connected || !this.outbox.length) return;
    while (this.outbox.length) {
      const pageId = this.outbox[0].page_id;
      const ops = [];
      while (this.outbox.length && this.outbox[0].page_id === pageId && ops.length < MAX_BATCH) {
        ops.push(this.outbox.shift().op);
      }
      const batch = { page_id: pageId, cid: this.cid, bid: ++this.bid, ops };
      this.pending.set(batch.bid, batch);
      this._sendBatch(batch);
    }
  }

  _sendBatch(batch) {
    this.call('op:batch', batch).then((ack) => {
      if (ack && ack.ok) {
        this.pending.delete(batch.bid);
        this._emit('acked', { batch, ack });
      } else if (ack && ack.error === 'server') {
        setTimeout(() => this.connected && this._sendBatch(batch), 2000);   // 일시 오류는 재시도
      } else {
        this.pending.delete(batch.bid);
        this._emit('rejected', { batch, error: ack && ack.error });
      }
    }).catch(() => { /* 연결 끊김: pending 에 남아 재연결 후 resend() */ });
  }

  // 재연결 후 방에 다시 들어간 다음 호출합니다.
  resend() {
    for (const b of [...this.pending.values()].sort((a, b) => a.bid - b.bid)) this._sendBatch(b);
    this.flush();
  }

  // 아직 서버가 확정하지 않은 내 동작들 (상태를 다시 받은 뒤 그 위에 다시 적용)
  unconfirmed(pageId) {
    const out = [];
    for (const b of [...this.pending.values()].sort((a, b) => a.bid - b.bid)) {
      if (b.page_id === pageId) out.push(...b.ops);
    }
    for (const x of this.outbox) if (x.page_id === pageId) out.push(x.op);
    return out;
  }

  live(data) {
    this.socket.volatile.emit('stroke:live', data);
  }
}
