// 합반 수업 음성·웹캠(WebRTC). 진행 기기 하나가 받는 기기마다 연결을 하나씩 만들어 보냅니다(보내기만).
// 시그널(offer/answer/ICE)은 기존 소켓으로 서버가 전달합니다. 영상은 학교망 안에서는 기기끼리 직접,
// 밖(집에 있는 학생)은 TURN 을 거쳐 갑니다.
const $ = (s, el = document) => el.querySelector(s);

async function iceServers(net) {
  try {
    const token = net.lastToken || await net.token();
    const r = await fetch('/eboard-api/rtc/ice', { headers: { Authorization: 'Bearer ' + token } });
    if (r.ok) return (await r.json()).iceServers;
  } catch { /* 무시 */ }
  return [];
}

// ── 보내는 쪽(진행 교사 기기) ──
export class Broadcaster {
  constructor(net, { onState } = {}) {
    this.net = net; this.onState = onState || (() => {});
    this.stream = null; this.pcs = new Map(); this.ice = null;
    this.cam = true; this.mic = true; this.hd = false;
    net.addEventListener('rtc:signal', (e) => this._signal(e.detail));
    net.addEventListener('rtc:peer', (e) => { const d = e.detail; if (!this.stream) return; d.on ? this._call(d.sid) : this._drop(d.sid); });
    net.addEventListener('rtc:stop', (e) => { if (e.detail && e.detail.reason === 'replaced') this.stop(true); });
  }

  get on() { return !!this.stream; }

  async start({ camId = '', micId = '', cam = true, mic = true, hd = false } = {}) {
    this.cam = cam; this.mic = mic; this.hd = hd;
    const video = cam ? { width: { ideal: hd ? 1280 : 640 }, height: { ideal: hd ? 720 : 360 }, frameRate: { ideal: hd ? 24 : 20 }, ...(camId ? { deviceId: { exact: camId } } : {}) } : false;
    const audio = mic ? { echoCancellation: true, noiseSuppression: true, autoGainControl: true, ...(micId ? { deviceId: { exact: micId } } : {}) } : false;
    if (!video && !audio) throw new Error('카메라나 마이크 중 하나는 켜야 합니다');
    const stream = await navigator.mediaDevices.getUserMedia({ video, audio });
    this.stop(true);
    this.stream = stream;
    this.ice = await iceServers(this.net);
    const r = await this.net.call('rtc:on', {}).catch(() => null);
    if (!r || !r.ok) { this.stop(true); throw new Error('송출을 시작하지 못했습니다' + (r && r.error ? ` (${r.error})` : '')); }
    for (const sid of r.peers) this._call(sid);
    this.onState();
    return stream;
  }

  stop(silent = false) {
    for (const sid of [...this.pcs.keys()]) this._drop(sid);
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    const was = !!this.stream;
    this.stream = null;
    if (was && !silent) this.net.call('rtc:off', {}).catch(() => {});
    this.onState();
  }

  setMuted(kind, muted) {
    if (!this.stream) return;
    for (const t of this.stream.getTracks()) if (t.kind === kind) t.enabled = !muted;
    this.onState();
  }

  isMuted(kind) {
    const t = this.stream && this.stream.getTracks().find((x) => x.kind === kind);
    return !t || !t.enabled;
  }

  stats() {
    let ok = 0;
    for (const pc of this.pcs.values()) if (pc.connectionState === 'connected') ok++;
    return { peers: this.pcs.size, connected: ok };
  }

  _send(to, data) { this.net.socket.emit('rtc:signal', { to, data }); }

  async _call(sid) {
    this._drop(sid);
    const pc = new RTCPeerConnection({ iceServers: this.ice || [] });
    this.pcs.set(sid, pc);
    for (const t of this.stream.getTracks()) pc.addTransceiver(t, { direction: 'sendonly', streams: [this.stream] });
    pc.onicecandidate = (e) => { if (e.candidate) this._send(sid, { ice: e.candidate.toJSON() }); };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') { this._call(sid); return; }   // 한 번 더 시도
      this.onState();
    };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this._send(sid, { sdp: pc.localDescription.toJSON() });
  }

  _drop(sid) {
    const pc = this.pcs.get(sid);
    if (pc) { pc.onconnectionstatechange = null; pc.close(); this.pcs.delete(sid); this.onState(); }
  }

  async _signal({ from, data }) {
    const pc = this.pcs.get(from);
    if (!pc) return;
    try {
      if (data.sdp && data.sdp.type === 'answer') await pc.setRemoteDescription(data.sdp);
      else if (data.ice) await pc.addIceCandidate(data.ice);
    } catch { /* 늦게 온 후보 등은 무시 */ }
  }
}

// ── 받는 쪽(참여 반 전자칠판, 집에 있는 학생) ──
export class Receiver {
  constructor(net, { toast } = {}) {
    this.net = net; this.toast = toast || (() => {});
    this.pc = null; this.from = null; this.ice = null; this.size = 'small';
    this._build();
    net.addEventListener('rtc:signal', (e) => this._signal(e.detail));
    net.addEventListener('rtc:stop', () => this.close());
  }

  _build() {
    const el = document.createElement('div');
    el.className = 'rtc-view'; el.hidden = true;
    el.innerHTML = `
      <video playsinline autoplay></video>
      <div class="rtc-audio-only">선생님 음성</div>
      <button type="button" class="rtc-unmute" hidden>🔊 소리 켜기</button>
      <div class="rtc-bar">
        <button type="button" data-r="size">크게</button>
        <button type="button" data-r="mute">소리 끄기</button>
        <button type="button" data-r="hide" aria-label="숨기기">✕</button>
      </div>`;
    document.body.appendChild(el);
    this.el = el;
    this.video = $('video', el);
    $('.rtc-unmute', el).onclick = () => this._unmute();
    el.querySelector('.rtc-bar').onclick = (e) => {
      const a = e.target.closest('[data-r]')?.dataset.r;
      if (a === 'size') { this.size = this.size === 'small' ? 'large' : 'small'; this._sync(); }
      else if (a === 'mute') { this.video.muted = !this.video.muted; this._sync(); }
      else if (a === 'hide') { el.classList.add('min'); }
    };
    el.addEventListener('click', (e) => { if (el.classList.contains('min') && !e.target.closest('.rtc-bar')) el.classList.remove('min'); });
  }

  _sync() {
    this.el.classList.toggle('large', this.size === 'large');
    this.el.querySelector('[data-r="size"]').textContent = this.size === 'large' ? '작게' : '크게';
    this.el.querySelector('[data-r="mute"]').textContent = this.video.muted ? '소리 켜기' : '소리 끄기';
    const s = this.video.srcObject;
    this.el.classList.toggle('audio-only', !!s && !s.getVideoTracks().some((t) => t.readyState === 'live' && t.enabled));
  }

  async _unmute() {
    this.video.muted = false;
    try { await this.video.play(); $('.rtc-unmute', this.el).hidden = true; } catch { /* 다시 누르기 */ }
    this._sync();
  }

  async _play() {
    this.video.muted = false;
    try {
      await this.video.play();
      $('.rtc-unmute', this.el).hidden = true;
    } catch {
      // 브라우저가 사용자 동작 없이는 소리를 막음 → 영상은 소리 없이 틀고 '소리 켜기' 표시
      this.video.muted = true;
      try { await this.video.play(); } catch { /* 무시 */ }
      $('.rtc-unmute', this.el).hidden = false;
    }
    this._sync();
  }

  close() {
    if (this.pc) { this.pc.ontrack = null; this.pc.close(); }
    this.pc = null; this.from = null;
    this.video.srcObject = null;
    this.el.hidden = true;
  }

  async _signal({ from, data }) {
    try {
      if (data.sdp && data.sdp.type === 'offer') {
        this.close();
        if (!this.ice) this.ice = await iceServers(this.net);
        const pc = new RTCPeerConnection({ iceServers: this.ice });
        this.pc = pc; this.from = from;
        const stream = new MediaStream();
        pc.ontrack = (e) => {
          stream.addTrack(e.track);
          e.track.onunmute = () => this._sync();
          e.track.onended = () => this._sync();
          if (this.video.srcObject !== stream) { this.video.srcObject = stream; this.el.hidden = false; this.el.classList.remove('min'); this._play(); }
          this._sync();
        };
        pc.onicecandidate = (e) => { if (e.candidate) this.net.socket.emit('rtc:signal', { to: from, data: { ice: e.candidate.toJSON() } }); };
        pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed') this.toast('선생님 영상 연결이 끊겼습니다. 다시 연결 중…'); };
        await pc.setRemoteDescription(data.sdp);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.net.socket.emit('rtc:signal', { to: from, data: { sdp: pc.localDescription.toJSON() } });
      } else if (data.ice && this.pc && from === this.from) {
        await this.pc.addIceCandidate(data.ice);
      }
    } catch { /* 무시 */ }
  }
}
