// 학생 호출(교사 쪽): 수업 도구의 '호출' 탭, 칠판 아래 호출 막대, 학생 사진 승인
// 학생은 student.php 를 열어 두면 부를 수 있습니다. 칠판은 부른 학생에게만, 허락한 동안만 보입니다.
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MODE = { photo: '사진', solve: '칠판 풀이', watch: '원격 참여' };
const ERR = { bad_class: '합반에 참여하지 않은 반입니다', already_called: '이미 부른 학생입니다', too_many: '동시에 부를 수 있는 학생 수(8명)를 넘었습니다', no_student: '명단에 계정이 연결되지 않은 번호입니다' };

export class CallTools {
  constructor({ net, toast, sound }) {
    this.net = net; this.toast = toast; this.sound = sound || (() => {});
    this.grants = []; this.online = new Set();
    this.sel = null;            // 호출 탭에서 고른 번호
    this.selClass = null;       // 합반일 때 고른 반 'g-c'
    this.rosters = new Map();   // 'g-c' → 명단(합반 참여 반)
    this.getClass = () => null; this.joint = null; this.api = null;
    this.tabBody = null; this.students = [];
    this._seenPhotos = new Set();
    this._buildStrip();
    this._buildApprove();
    net.addEventListener('call:grants', (e) => this._update(e.detail));
    setInterval(() => this._renderStrip(), 1000);      // 남은 시간 표시
  }

  async refresh() {
    const r = await this.net.call('call:list', {}).catch(() => null);
    if (r && r.ok) this._update(r);
  }

  _update(d) {
    this.grants = d.grants || [];
    this.online = new Set(d.online || []);
    for (const g of this.grants) {
      if (g.photo && !this._seenPhotos.has(g.photo.id)) { this._seenPhotos.add(g.photo.id); this.sound('correct'); this.toast(`${g.seat}. ${g.name} 사진이 도착했습니다`); }
    }
    this._renderStrip();
    if (this.tabBody && this.tabBody.isConnected) this.renderTab(this.tabBody, this.students);
    if (!this.approveEl.hidden) {
      const g = this.grants.find((x) => x.id === this.approveId);
      if (!g || !g.photo) this.approveEl.hidden = true;
    }
  }

  // ── 수업 도구의 '호출' 탭 ──
  _myKey() { const k = this.getClass(); return k ? `${k.grade}-${k.class}` : ''; }

  _classKeys() {
    const mine = this._myKey();
    const st = this.joint && this.joint.state;
    return [mine, ...((st && st.active) ? st.classes.map((c) => `${c.grade}-${c.class}`) : [])].filter(Boolean);
  }

  async _studentsOf(key, fallback) {
    if (!key || key === this._myKey()) return fallback;
    if (this.rosters.has(key)) return this.rosters.get(key);
    const [g, c] = key.split('-');
    try {
      const j = await this.api(`/roster?grade=${g}&class=${c}`);
      const list = j.seats.filter((x) => x.status === 'active').map((x) => ({ seat: x.seat, name: x.name }));
      this.rosters.set(key, list);
      return list;
    } catch { return []; }
  }

  async renderTab(body, students) {
    this.tabBody = body; this.students = students;
    const keys = this._classKeys();
    if (!keys.includes(this.selClass)) this.selClass = keys[0] || null;
    const ck = this.selClass, [cg, cc] = (ck || '-').split('-').map(Number);
    const list = await this._studentsOf(ck, students);
    const called = new Map(this.grants.filter((g) => `${g.grade}-${g.class}` === ck).map((g) => [g.seat, g]));
    const sel = this.sel;
    body.innerHTML = `
      <p class="muted small">학생은 태블릿에서 <b>${esc(location.origin)}/eboard/student.php</b> 를 열어 두면 됩니다. 초록 점 = 지금 열어 둔 학생</p>
      ${keys.length > 1 ? `<div class="ct-row call-classes">${keys.map((k) => `<button type="button" class="chip ${k === ck ? 'on' : ''}" data-ck="${k}">${k.replace('-', '학년 ')}반</button>`).join('')}</div>` : ''}
      <div class="ct-chips call-chips">${list.map((st) => {
        const g = called.get(st.seat);
        return `<button type="button" data-seat="${st.seat}" class="${sel === st.seat ? 'on' : ''} ${g ? 'picked' : ''}">
          <i class="dot ${this.online.has(`${cg}-${cc}-${st.seat}`) ? 'on' : ''}"></i>${esc(`${st.seat}. ${st.name}`)}${g ? ` · ${MODE[g.mode]}` : ''}</button>`;
      }).join('')}</div>
      <div class="ct-row call-actions">
        <button type="button" class="ct-big" data-mode="solve" ${sel ? '' : 'disabled'}>칠판에 풀기</button>
        <button type="button" class="ct-big alt" data-mode="photo" ${sel ? '' : 'disabled'}>사진 받기</button>
        <button type="button" class="ct-big alt" data-mode="watch" ${sel ? '' : 'disabled'} title="집에 있는 학생: 칠판·선생님 음성과 영상을 보고 손들기">원격 참여(집)</button>
      </div>
      <p class="muted small">칠판에 풀기: 부른 학생의 태블릿에 지금 칠판이 보이고, 학생이 쓴 것이 칠판에 바로 나옵니다(자기가 쓴 것만 지울 수 있음).<br>
      사진 받기: 학생이 찍어 보낸 사진을 선생님이 보고 칠판에 넣습니다.<br>
      원격 참여: 아파서 집에 있는 학생이 칠판과 합반 수업 음성·영상을 보고, 손을 들면 칠판에 쓰게 해 줄 수 있습니다.</p>`;
    body.querySelector('.call-classes')?.addEventListener('click', (e) => {
      const b = e.target.closest('[data-ck]'); if (!b) return;
      this.selClass = b.dataset.ck; this.sel = null; this.renderTab(body, students);
    });
    $('.call-chips', body).onclick = (e) => {
      const b = e.target.closest('[data-seat]'); if (!b) return;
      this.sel = this.sel === +b.dataset.seat ? null : +b.dataset.seat;
      this.renderTab(body, students);
    };
    body.querySelectorAll('[data-mode]').forEach((b) => { b.onclick = () => this.invite(this.sel, b.dataset.mode); });
  }

  async invite(seat, mode) {
    if (!seat) return;
    const [grade, cls] = (this.selClass || this._myKey()).split('-').map(Number);
    const r = await this.net.call('call:invite', { seat, mode, grade, class: cls }).catch(() => null);
    if (!r || !r.ok) { this.toast(ERR[r && r.error] || `부르지 못했습니다${r && r.error ? ` (${r.error})` : ''}`, 3500); return; }
    this.sel = null;
    this.toast(r.online ? `${seat}번을 불렀습니다` : `${seat}번을 불렀습니다. 학생 화면이 아직 열려 있지 않습니다(3분 동안 기다림)`, 3500);
  }

  async endGrant(id) {
    const r = await this.net.call('call:end', { id }).catch(() => null);
    if (!r || !r.ok) this.toast('끝내지 못했습니다');
  }

  // ── 칠판 아래 호출 막대 ──
  _buildStrip() {
    const el = document.createElement('div');
    el.id = 'call-strip'; el.className = 'call-strip'; el.hidden = true;
    document.body.appendChild(el);
    this.strip = el;
    el.onclick = (e) => {
      const end = e.target.closest('[data-end]');
      if (end) { this.endGrant(+end.dataset.end); return; }
      const ph = e.target.closest('[data-photo]');
      if (ph) this.openApprove(+ph.dataset.photo);
      const ex = e.target.closest('[data-extend]');
      if (ex) this.net.call('call:extend', { id: +ex.dataset.extend }).catch(() => {});
      const md = e.target.closest('[data-cmode]');
      if (md) this.net.call('call:mode', { id: +md.dataset.id, mode: md.dataset.cmode }).catch(() => {});
    };
  }

  _status(g) {
    if (g.status === 'waiting') return '기다리는 중';
    if (g.hand) return '✋ 손 들었어요';
    if (g.home) return g.mode === 'solve' ? '집에서 쓰는 중' : '집에서 보는 중';
    if (g.mode === 'photo') return g.status === 'submitted' ? '사진 도착' : '사진 찍는 중';
    return g.done ? '다 했어요' : '풀이 중';
  }

  _renderStrip() {
    const el = this.strip;
    el.hidden = !this.grants.length;
    if (!this.grants.length) { el.innerHTML = ''; return; }
    const now = Date.now() / 1000;
    el.innerHTML = this.grants.map((g) => {
      const left = Math.max(0, Math.round(g.expires - now));
      const mm = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
      return `<div class="call-chip ${g.status} ${g.done ? 'done' : ''} ${g.hand ? 'hand' : ''}">
        ${g.photo ? `<button type="button" class="call-thumb" data-photo="${g.id}" title="사진 보기"><img src="${g.photo.thumb}" alt=""></button>` : ''}
        <span class="who">${esc(`${`${g.grade}-${g.class}` !== this._myKey() ? `${g.grade}-${g.class} ` : ''}${g.seat}. ${g.name}`)}</span>
        <span class="st">${MODE[g.mode]} · ${this._status(g)}</span>
        ${g.home && g.status === 'active' ? `<button type="button" class="time" data-id="${g.id}" data-cmode="${g.mode === 'solve' ? 'watch' : 'solve'}">${g.mode === 'solve' ? '보기만' : '쓰기 허락'}</button>` : ''}
        <button type="button" class="time" data-extend="${g.id}" title="10분 늘리기">${mm}</button>
        <button type="button" class="x" data-end="${g.id}" title="끝내기" aria-label="끝내기">끝</button>
      </div>`;
    }).join('');
  }

  // ── 사진 승인 ──
  _buildApprove() {
    const el = document.createElement('div');
    el.className = 'ct-overlay'; el.id = 'call-approve'; el.hidden = true;
    el.innerHTML = `
      <div class="ct-card wide call-card">
        <header><h3 id="ca-title"></h3><button type="button" class="ct-close" aria-label="닫기">✕</button></header>
        <div class="call-photo"><img id="ca-img" alt=""></div>
        <div class="md-actions">
          <button type="button" class="chip" data-act="reject">다시 보내 달라기</button>
          <button type="button" class="chip" data-act="bg">지금 페이지 배경으로</button>
          <button type="button" class="ct-big" data-act="page">새 페이지로 넣기</button>
        </div>
      </div>`;
    document.body.appendChild(el);
    this.approveEl = el;
    $('.ct-close', el).onclick = () => { el.hidden = true; };
    el.addEventListener('pointerdown', (e) => { if (e.target === el) el.hidden = true; });
    el.querySelectorAll('[data-act]').forEach((b) => { b.onclick = () => this.decide(b.dataset.act); });
  }

  openApprove(id) {
    const g = this.grants.find((x) => x.id === id);
    if (!g || !g.photo) return;
    this.approveId = id;
    $('#ca-title', this.approveEl).textContent = `${g.seat}. ${g.name}의 사진`;
    $('#ca-img', this.approveEl).src = g.photo.url;
    this.approveEl.hidden = false;
  }

  async decide(action) {
    const r = await this.net.call('call:photo', { id: this.approveId, action }).catch(() => null);
    if (!r || !r.ok) { this.toast('처리하지 못했습니다'); return; }
    this.approveEl.hidden = true;
    if (action === 'reject') this.toast('학생에게 다시 보내 달라고 했습니다');
  }
}
