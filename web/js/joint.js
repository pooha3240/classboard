// 합반 수업(교사 쪽): 진행 — 참여 반 고르기·음성·웹캠 송출·끝내기 / 참여 반 전자칠판 — 진행자 칠판을 보기 전용으로
import { Broadcaster, Receiver } from './rtc.js';
import { askConfirm } from './ui.js';

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ls = {
  get(k, d) { try { const v = localStorage.getItem('eboard.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('eboard.' + k, JSON.stringify(v)); } catch { /* 무시 */ } },
};
const ERR = { class_busy: '다른 합반 수업에 이미 참여 중인 반이 있습니다', class_hosting: '합반 수업을 진행 중인 반은 넣을 수 없습니다', bad_classes: '참여할 반을 고르세요', viewer: '보기 전용 화면에서는 할 수 없습니다' };

export class JointTools {
  // ctx: { net, tools, toast, api, getClass, rejoin(), loadPage(r), onViewer(on, host) }
  constructor(ctx) {
    this.c = ctx; this.net = ctx.net;
    this.state = { active: false };
    this.viewer = null;            // 보기 전용으로 참여 중이면 { host, room }
    this.declined = null;          // '우리 반 칠판으로' 누른 합반(다시 자동 참여하지 않음)
    this.bc = new Broadcaster(this.net, { onState: () => this._renderMedia() });
    this.rx = new Receiver(this.net, { toast: ctx.toast });
    this._buildPanel();
    this._buildChip();
    this._buildViewerBar();
    this.net.addEventListener('joint:invite', (e) => this._invited(e.detail));
    this.net.addEventListener('joint:ended', (e) => this._ended(e.detail));
    this.net.addEventListener('joint:state', (e) => this._setState(e.detail));
    setInterval(() => { if (this.bc.on) this._renderMedia(); }, 2000);
  }

  // app.js 의 room:join 응답 뒤에 부름
  afterJoin(r) {
    if (r.joint_invite && r.joint_invite.room !== this.declined) this._invited(r.joint_invite);
    else if (r.joint_host) this.refresh();
    else this._setState({ active: false });
  }

  async refresh() {
    const r = await this.net.call('joint:state', {}).catch(() => null);
    if (r && r.ok) this._setState(r);
  }

  // ── 참여 반 전자칠판: 보기 전용 ──
  async _invited(d) {
    if (this.viewer || !d || d.room === this.declined) return;
    const r = await this.net.call('joint:join', {}).catch(() => null);
    if (!r || !r.ok) return;
    this.viewer = { host: r.host, room: d.room };
    this.c.tools.readOnly = true;
    document.body.classList.add('viewer');
    $('#viewer-host').textContent = `${r.host} 합반 수업`;
    this.viewerBar.hidden = false;
    this.c.onViewer(true, r.host);
    this.c.loadPage(r);
    this.c.toast(`${r.host} 선생님의 합반 수업을 보는 중입니다`, 3500);
  }

  async _ended(d) {
    if (this.viewer) {
      const wasRemoved = d && d.reason === 'removed';
      this._exitViewer();
      this.c.toast(wasRemoved ? '합반 수업에서 빠졌습니다. 우리 반 칠판으로 돌아왔습니다' : '합반 수업이 끝났습니다. 우리 반 칠판으로 돌아왔습니다', 3500);
      await this.c.rejoin();
    } else {
      this.bc.stop(true);
      this._setState({ active: false });
    }
  }

  _exitViewer() {
    this.viewer = null;
    this.c.tools.readOnly = false;
    document.body.classList.remove('viewer');
    this.viewerBar.hidden = true;
    this.rx.close();
    this.c.onViewer(false);
  }

  async leaveViewer() {
    if (!this.viewer) return;
    this.declined = this.viewer.room;
    this._exitViewer();
    await this.c.rejoin();
    this.c.toast('우리 반 칠판으로 돌아왔습니다. 메뉴 → 합반 수업 보기로 다시 들어갈 수 있습니다', 4000);
  }

  async rejoinViewer() {
    this.declined = null;
    await this.c.rejoin();
  }

  _buildViewerBar() {
    const el = document.createElement('div');
    el.className = 'viewer-bar'; el.hidden = true;
    el.innerHTML = '<span class="live-dot"></span><b id="viewer-host"></b><span class="muted">보기 전용</span><button type="button" id="viewer-leave">우리 반 칠판으로</button>';
    document.body.appendChild(el);
    this.viewerBar = el;
    $('#viewer-leave', el).onclick = () => this.leaveViewer();
  }

  // ── 진행 교사 ──
  _buildChip() {
    const el = document.createElement('button');
    el.type = 'button'; el.className = 'joint-chip'; el.hidden = true;
    el.onclick = () => this.open();
    document.body.appendChild(el);
    this.chip = el;
  }

  _setState(st) {
    const wasActive = !!this.state.active;
    this.state = st || { active: false };
    const on = !!this.state.active;
    this.chip.hidden = !on || !!this.viewer;
    if (on) {
      const n = this.state.classes.length, con = this.state.classes.filter((c) => c.devices).length;
      const home = this.state.students.length;
      this.chip.innerHTML = `<span class="live-dot ${this.bc.on ? '' : 'off'}"></span>합반 ${con}/${n}반${home ? ` · 집 ${home}명` : ''}${this.bc.on ? ' · 송출 중' : ''}`;
    } else if (this.bc.on) this.bc.stop(true);
    if (!this.panel.hidden) { if (wasActive !== on) this._renderPanel(); else this._patchPanel(); }
    if (this.onStateChange) this.onStateChange();
  }

  // 상태만 바뀐 경우: 패널 전체를 다시 그리지 않고 연결 표시만 고침(누르던 버튼·미리보기가 사라지지 않게)
  _patchPanel() {
    const byCls = new Map((this.state.classes || []).map((c) => [`${c.grade}-${c.class}`, c]));
    this.panel.querySelectorAll('.jt-cls input[data-cls]').forEach((inp) => {
      const info = byCls.get(inp.dataset.cls), lab = inp.parentElement;
      let sm = lab.querySelector('small');
      if (!info) { if (sm) sm.remove(); return; }
      if (!sm) { sm = document.createElement('small'); lab.appendChild(sm); }
      sm.className = info.devices ? 'ok' : ''; sm.textContent = info.devices ? '연결' : '대기';
    });
    const homes = this.state.students || [];
    let hp = this.panel.querySelector('.jt-homes');
    if (homes.length) {
      if (!hp) { hp = document.createElement('p'); hp.className = 'small jt-homes'; this.panel.querySelector('.jt-classes').after(hp); }
      hp.textContent = `집에서 참여: ${homes.map((x) => `${x.grade}-${x.class} ${x.name}`).join(', ')}`;
    } else if (hp) hp.remove();
    this._renderMedia();
  }

  _buildPanel() {
    const el = document.createElement('div');
    el.className = 'ct-overlay'; el.id = 'joint-panel'; el.hidden = true;
    el.innerHTML = `
      <div class="ct-card wide jt-card">
        <header><h3>합반 수업</h3><button type="button" class="ct-close" aria-label="닫기">✕</button></header>
        <div class="jt-body"></div>
      </div>`;
    document.body.appendChild(el);
    this.panel = el;
    $('.ct-close', el).onclick = () => { el.hidden = true; };
    el.addEventListener('pointerdown', (e) => { if (e.target === el) el.hidden = true; });
    el.addEventListener('click', (e) => this._panelClick(e));
    el.addEventListener('change', (e) => this._panelChange(e));
  }

  async open() {
    if (this.viewer) { this.c.toast('합반 수업을 보는 중에는 진행할 수 없습니다'); return; }
    if (!this.classes) {
      try { this.classes = (await this.c.api('/classes')).classes; } catch { this.classes = []; }
    }
    await this.refresh();
    this.sel = new Set((this.state.active ? this.state.classes : []).map((c) => `${c.grade}-${c.class}`));
    this.panel.hidden = false;
    this._renderPanel();
  }

  _renderPanel() {
    const me = this.c.getClass();
    const st = this.state, on = !!st.active;
    const byCls = new Map((on ? st.classes : []).map((c) => [`${c.grade}-${c.class}`, c]));
    const grades = [...new Set(this.classes.map((c) => c.grade))];
    const pick = grades.map((g) => {
      const list = this.classes.filter((c) => c.grade === g && !(me && c.grade === me.grade && c.class === me.class));
      if (!list.length) return '';
      return `<div class="jt-grade"><b>${g}학년</b> ${list.map((c) => {
        const k = `${c.grade}-${c.class}`, info = byCls.get(k);
        return `<label class="jt-cls ${this.sel.has(k) ? 'on' : ''}"><input type="checkbox" data-cls="${k}" ${this.sel.has(k) ? 'checked' : ''}>${c.class}반${info ? `<small class="${info.devices ? 'ok' : ''}">${info.devices ? '연결' : '대기'}</small>` : ''}</label>`;
      }).join('')}</div>`;
    }).join('');
    const homes = on && st.students.length ? `<p class="small jt-homes">집에서 참여: ${st.students.map((s) => esc(`${s.grade}-${s.class} ${s.name}`)).join(', ')}</p>` : '';
    $('.jt-body', this.panel).innerHTML = `
      <p class="muted small">${me ? `${me.grade}학년 ${me.class}반 칠판을` : '이 칠판을'} 고른 반의 전자칠판에 그대로 보여 줍니다. 참여 반 칠판은 보기 전용이 되고, 판서 기록은 모든 반에 남습니다.</p>
      <div class="jt-classes">${pick || '<p class="muted">학급 목록이 없습니다</p>'}</div>
      ${homes}
      <div class="md-actions">
        ${on ? '<button type="button" class="chip danger-text" data-j="end">합반 끝내기</button>' : ''}
        <button type="button" class="ct-big" data-j="start" ${this.sel.size ? '' : 'disabled'}>${on ? '참여 반 바꾸기' : `합반 시작 (${this.sel.size}개 반)`}</button>
      </div>
      <div class="jt-media" ${on ? '' : 'hidden'}>
        <h4>음성·웹캠 보내기</h4>
        <div class="jt-media-row">
          <video class="jt-self" muted playsinline autoplay></video>
          <div class="jt-media-ctl">
            <label>카메라 <select data-m="cam"></select></label>
            <label>마이크 <select data-m="mic"></select></label>
            <label class="check"><input type="checkbox" data-m="hd" ${ls.get('jt.hd', false) ? 'checked' : ''}> 선명하게(실물화상기용, 기기 부담 큼)</label>
            <div class="jt-media-btns"></div>
            <p class="muted small jt-media-st"></p>
          </div>
        </div>
        <p class="muted small">진행 교실 스피커로 소리가 나지 않으니 울림은 생기지 않습니다. 참여 반 전자칠판에서 '소리 켜기'가 보이면 한 번 눌러 주세요.</p>
      </div>`;
    if (on) { this._fillDevices(); this._renderMedia(); }
  }

  async _fillDevices() {
    let devs = [];
    try { devs = await navigator.mediaDevices.enumerateDevices(); } catch { /* 무시 */ }
    const fill = (kind, key, label) => {
      const sel = $(`[data-m="${key}"]`, this.panel); if (!sel) return;
      const list = devs.filter((d) => d.kind === kind);
      const cur = ls.get(`jt.${key}`, '');
      sel.innerHTML = `<option value="off">끄기</option><option value="" ${cur === '' ? 'selected' : ''}>기본 ${label}</option>` +
        list.filter((d) => d.deviceId && d.deviceId !== 'default').map((d, i) => `<option value="${esc(d.deviceId)}" ${d.deviceId === cur ? 'selected' : ''}>${esc(d.label || `${label} ${i + 1}`)}</option>`).join('');
      if (cur === 'off') sel.value = 'off';
    };
    fill('videoinput', 'cam', '카메라');
    fill('audioinput', 'mic', '마이크');
  }

  _renderMedia() {
    const box = $('.jt-media-btns', this.panel);
    if (!box) return;
    const bc = this.bc;
    const sig = `${bc.on}|${bc.isMuted('audio')}|${bc.isMuted('video')}`;
    if (box.dataset.sig !== sig) box.dataset.sig = sig; else { const s0 = bc.stats(); $('.jt-media-st', this.panel).textContent = bc.on ? `연결 ${s0.connected}/${s0.peers}` : ''; this._setStateChipOnly(); return; }
    box.innerHTML = bc.on
      ? `<button type="button" class="chip" data-m="mute-audio">${bc.isMuted('audio') ? '마이크 켜기' : '마이크 잠깐 끄기'}</button>
         <button type="button" class="chip" data-m="mute-video">${bc.isMuted('video') ? '카메라 켜기' : '카메라 잠깐 끄기'}</button>
         <button type="button" class="chip danger-text" data-m="stop">보내기 멈춤</button>`
      : '<button type="button" class="ct-big" data-m="start">음성·웹캠 보내기 시작</button>';
    const s = bc.stats();
    $('.jt-media-st', this.panel).textContent = bc.on ? `연결 ${s.connected}/${s.peers}` : '';
    const v = $('.jt-self', this.panel);
    if (v && v.srcObject !== bc.stream) v.srcObject = bc.stream;
    if (this.state.active) this._setStateChipOnly();
  }

  _setStateChipOnly() {
    const st = this.state;
    if (!st.active) return;
    const n = st.classes.length, con = st.classes.filter((c) => c.devices).length, home = st.students.length;
    this.chip.innerHTML = `<span class="live-dot ${this.bc.on ? '' : 'off'}"></span>합반 ${con}/${n}반${home ? ` · 집 ${home}명` : ''}${this.bc.on ? ' · 송출 중' : ''}`;
  }

  _panelChange(e) {
    const k = e.target.dataset.cls;
    if (k) { e.target.checked ? this.sel.add(k) : this.sel.delete(k); this._renderPanel(); return; }
    const m = e.target.dataset.m;
    if (m === 'cam' || m === 'mic') ls.set(`jt.${m}`, e.target.value);
    if (m === 'hd') ls.set('jt.hd', e.target.checked);
  }

  async _panelClick(e) {
    const j = e.target.closest('[data-j]')?.dataset.j;
    const m = e.target.closest('button[data-m]')?.dataset.m;
    if (j === 'start') {
      const classes = [...this.sel].map((k) => k.split('-').map(Number));
      const r = await this.net.call('joint:start', { classes }).catch(() => null);
      if (!r || !r.ok) { this.c.toast((ERR[r && r.error] || '합반을 시작하지 못했습니다') + (r && r.class ? ` (${r.class})` : ''), 3500); return; }
      this._setState(r);
      this.c.toast('합반 수업을 시작했습니다. 참여 반 전자칠판에 이 칠판이 보입니다', 3500);
    } else if (j === 'end') {
      if (!(await askConfirm('합반 수업을 끝낼까요? 참여 반 칠판은 자기 반 칠판으로 돌아갑니다.', '끝내기', { danger: true }))) return;
      this.bc.stop();
      await this.net.call('joint:end', {}).catch(() => null);
      this._setState({ active: false });
    } else if (m === 'start') {
      const cam = ls.get('jt.cam', ''), mic = ls.get('jt.mic', '');
      try {
        await this.bc.start({ cam: cam !== 'off', mic: mic !== 'off', camId: cam === 'off' ? '' : cam, micId: mic === 'off' ? '' : mic, hd: ls.get('jt.hd', false) });
        this._fillDevices();
      } catch (err) {
        this.c.toast(err.name === 'NotAllowedError' ? '카메라·마이크 권한이 거부되었습니다. 주소창 왼쪽 아이콘에서 허용하세요' : (err.message || '시작하지 못했습니다'), 4500);
      }
    } else if (m === 'stop') this.bc.stop();
    else if (m === 'mute-audio') this.bc.setMuted('audio', !this.bc.isMuted('audio'));
    else if (m === 'mute-video') this.bc.setMuted('video', !this.bc.isMuted('video'));
  }
}
