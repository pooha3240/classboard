// 수업 도구: 뽑기·모둠·자리 배치·타이머·주사위·효과음
// 결과는 tool:event 로 같은 학급의 다른 교사 기기(전자칠판 등)에 똑같이 보입니다.
import { askText } from './ui.js';
import { play, SOUND_LIST, unlockOnGesture, soundReady } from './sound.js';

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
const ls = {
  get(k, d) { try { const v = localStorage.getItem('eboard.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('eboard.' + k, JSON.stringify(v)); } catch { /* 무시 */ } },
};

function rnd(n) {                     // 0..n-1, 치우침 없는 난수
  const a = new Uint32Array(1), lim = Math.floor(0x100000000 / n) * n;
  do crypto.getRandomValues(a); while (a[0] >= lim);
  return a[0] % n;
}
export function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = rnd(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// ── 모둠 나누기: 같이(묶음)·따로(분리) 조건을 만족하는 무작위 배치 ──
export function makeGroups(students, { count, size, together = [], apart = [] }) {
  const n = students.length;
  const g = count ? Math.max(1, Math.min(count, n)) : Math.max(1, Math.ceil(n / Math.max(1, size)));
  const parent = new Map(students.map((s) => [s, s]));
  const find = (x) => (parent.get(x) === x ? x : find(parent.get(x)));
  for (const [a, b] of together) if (parent.has(a) && parent.has(b)) parent.set(find(a), find(b));
  const unitsMap = new Map();
  for (const s of students) { const r = find(s); if (!unitsMap.has(r)) unitsMap.set(r, []); unitsMap.get(r).push(s); }
  const units = [...unitsMap.values()];
  const cap = Math.ceil(n / g);
  let best = null, bestBad = Infinity;
  for (let tries = 0; tries < 3000 && bestBad > 0; tries++) {
    const groups = Array.from({ length: g }, () => []);
    for (const u of shuffle(units).sort((a, b) => b.length - a.length)) {
      const open = groups.map((x, i) => i).filter((i) => groups[i].length + u.length <= cap);
      const pool = open.length ? open : groups.map((x, i) => i);
      const minLen = Math.min(...pool.map((i) => groups[i].length));
      const cand = pool.filter((i) => groups[i].length === minLen);
      groups[cand[rnd(cand.length)]].push(...u);
    }
    let bad = 0;
    for (const [a, b] of apart) if (groups.some((x) => x.includes(a) && x.includes(b))) bad++;
    if (bad < bestBad) { bestBad = bad; best = groups.map(shuffle); }
  }
  return { groups: best, violations: bestBad };
}

// ── 자리 배치 ──
// 칠판에서 먼 줄의 끝자리부터 빈자리로(인원보다 자리가 많을 때)
export function autoEmpty(rows, cols, count, deskTop = true) {
  const extra = Math.max(0, rows * cols - count);
  const out = [];
  for (let i = 0; i < extra; i++) {
    const line = Math.floor(i / cols), col = cols - 1 - (i % cols);   // 맨 뒷줄 오른쪽부터
    const r = deskTop ? rows - 1 - line : line;
    out.push(`${r}-${col}`);
  }
  return out;
}

export function makeSeating(students, { rows, cols, empty = [], fixed = {}, front = [], apart = [], deskTop = true }) {
  const cells = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (!empty.includes(`${r}-${c}`)) cells.push(`${r}-${c}`);
  const fixedStu = new Set(Object.values(fixed));
  const free = cells.filter((k) => !fixed[k]);
  const rest = students.filter((s) => !fixedStu.has(s));
  const frontSet = new Set(front.filter((s) => rest.includes(s)));
  const near = (a, b) => { const [r1, c1] = a.split('-').map(Number), [r2, c2] = b.split('-').map(Number); return Math.abs(r1 - r2) + Math.abs(c1 - c2) === 1; };
  let best = null, bestBad = Infinity;
  for (let tries = 0; tries < 2000 && bestBad > 0; tries++) {
    // 칠판에 가까운 줄부터(같은 줄 안은 무작위). 자리가 남으면 뒷줄이 비게 됩니다.
    const dist = (k) => { const r = +k.split('-')[0]; return deskTop ? r : rows - 1 - r; };
    const order = shuffle(free.slice()).sort((a, b) => dist(a) - dist(b));
    const need = frontSet.size + rest.filter((s) => !frontSet.has(s)).length;
    const frontCells = order.slice(0, frontSet.size);
    const others = shuffle(order.slice(frontSet.size, need));
    const map = { ...fixed };
    const fc = shuffle(frontCells);
    shuffle([...frontSet]).forEach((s, i) => { map[fc[i]] = s; });
    const remain = shuffle(rest.filter((s) => !frontSet.has(s)));
    others.forEach((k, i) => { if (i < remain.length) map[k] = remain[i]; });
    let bad = 0;
    const where = Object.fromEntries(Object.entries(map).map(([k, s]) => [s, k]));
    for (const [a, b] of apart) if (where[a] && where[b] && near(where[a], where[b])) bad++;
    if (bad < bestBad) { bestBad = bad; best = map; }
  }
  return { seats: best || {}, violations: bestBad === Infinity ? 0 : bestBad };
}

export class ClassTools {
  constructor({ net, getClass, getPeers, device, toast, goPage }) {
    Object.assign(this, { net, getClass, getPeers, device, toast, goPage });
    this.students = [];      // {seat, name}
    this.timer = null;       // {mode:'down'|'up', endAt, startAt, paused, remain}
    this.seating = null;
    unlockOnGesture();
    this._build();
  }

  get key() { const k = this.getClass(); return k ? `${k.grade}-${k.class}` : 'none'; }
  _emit(data) { if (this.net.connected) this.net.socket.emit('tool:event', data); }
  _hasDisplay() { return this.getPeers().some((p) => p.device === 'display'); }

  // 교실 스피커는 전자칠판: 전자칠판이 접속해 있으면 그쪽에서만 소리를 냅니다.
  sound(id, fromRemote = false) {
    if (this.device === 'display' || !this._hasDisplay()) {
      if (!play(id) && !soundReady()) this.toast('소리를 내려면 화면을 한 번 터치하세요');
    }
    if (!fromRemote) this._emit({ kind: 'sound', id });
  }

  // ── 명단 ──
  async loadRoster() {
    const k = this.getClass();
    if (!k) return [];
    const t = this.net.lastToken || await this.net.token();
    const r = await fetch(`/eboard-api/roster?grade=${k.grade}&class=${k.class}`, { headers: { Authorization: 'Bearer ' + t } });
    const j = await r.json();
    if (!r.ok) throw new Error((j.detail && j.detail.message) || '명단을 불러오지 못했습니다');
    this.students = j.seats.filter((s) => s.status === 'active').map((s) => ({ seat: s.seat, name: s.name }));
    this.pending = j.seats.filter((s) => s.status === 'pending').length;
    return this.students;
  }
  label(s) { return s.name ? `${s.seat}. ${s.name}` : `${s.seat}번`; }   // classboard: 서버에는 번호만 있음
  absentKey() { return `absent.${this.key}.${today()}`; }
  absent() { return new Set(ls.get(this.absentKey(), [])); }
  present() { const ab = this.absent(); return this.students.filter((s) => !ab.has(s.seat)); }

  // ── 화면 ──
  _build() {
    const panel = document.createElement('aside');
    panel.id = 'ct-panel'; panel.className = 'ct-panel'; panel.hidden = true;
    panel.innerHTML = `
      <header><div class="ct-tabs">${[['pick', '뽑기'], ['call', '호출'], ['groups', '모둠'], ['seat', '자리'], ['timer', '타이머'], ['dice', '주사위'], ['sound', '소리']]
        .map(([k, l]) => `<button type="button" data-tab="${k}">${l}</button>`).join('')}</div>
        <button type="button" class="ct-close" aria-label="닫기">✕</button></header>
      <div class="ct-body"></div>`;
    document.body.appendChild(panel);
    panel.querySelector('.ct-close').onclick = () => this.close();
    panel.querySelector('.ct-tabs').onclick = (e) => { const t = e.target.dataset.tab; if (t) this.tab(t); };
    this.panel = panel;

    const ov = document.createElement('div');
    ov.id = 'ct-overlay'; ov.className = 'ct-overlay'; ov.hidden = true;
    document.body.appendChild(ov);
    this.ov = ov;
    ov.addEventListener('click', (e) => { if (e.target === ov || e.target.closest('.ct-ov-close')) this.hideOverlay(true); });

    const tw = document.createElement('div');
    tw.id = 'ct-timer'; tw.className = 'ct-timer'; tw.hidden = true;
    document.body.appendChild(tw);
    tw.innerHTML = '<span class="t-txt"></span><button type="button" class="t-x" aria-label="타이머 닫기">✕</button>';
    tw.onclick = (e) => {
      if (e.target.closest('.t-x')) { this.stopTimer(); return; }
      tw.classList.toggle('big');
    };
    this.tw = tw;
  }

  toggle() { this.panel.hidden ? this.open() : this.close(); }
  async open(tab = this.curTab || 'pick') {
    this.panel.hidden = false;
    try { await this.loadRoster(); } catch (e) { this.toast(e.message); }
    this.tab(tab);
  }
  close() { this.panel.hidden = true; }

  tab(t) {
    this.curTab = t;
    for (const b of this.panel.querySelectorAll('[data-tab]')) b.classList.toggle('on', b.dataset.tab === t);
    const body = this.panel.querySelector('.ct-body');
    body.innerHTML = '';
    ({ pick: () => this._pickTab(body), call: () => (this.calls ? this.calls.renderTab(body, this.students) : null), groups: () => this._groupsTab(body), seat: () => this._seatTab(body),
       timer: () => this._timerTab(body), dice: () => this._diceTab(body), sound: () => this._soundTab(body) })[t]();
  }

  _rosterNote(body) {
    const p = document.createElement('p');
    p.className = 'muted small';
    p.innerHTML = `명단 ${this.students.length}명${this.pending ? ` · 확인 필요 ${this.pending}명` : ''} · <a href="#" data-roster>명단 관리</a>`;
    p.querySelector('[data-roster]').onclick = (e) => { e.preventDefault(); this.goPage('roster.php'); };
    body.appendChild(p);
  }

  // ── 뽑기 ──
  _pickTab(body) {
    const picked = new Set(ls.get(`picked.${this.key}.${today()}`, []));
    const ab = this.absent();
    body.innerHTML = `
      <div class="ct-row"><label>몇 명 <select id="pick-n">${[1, 2, 3, 4, 5].map((n) => `<option>${n}</option>`).join('')}</select></label>
        <label class="check"><input type="checkbox" id="pick-ex" checked> 오늘 뽑힌 학생 빼기</label></div>
      <button type="button" class="ct-big" id="pick-go">뽑기</button>
      <p class="muted small">오늘 뽑힌 학생 ${picked.size}명 <a href="#" id="pick-reset">처음부터</a></p>
      <h4>출석 (누르면 결석 표시)</h4>
      <div class="ct-chips" id="pick-att">${this.students.map((s) => `<button type="button" class="${ab.has(s.seat) ? 'off' : ''} ${picked.has(s.seat) ? 'picked' : ''}" data-seat="${s.seat}">${esc(this.label(s))}</button>`).join('')}</div>`;
    this._rosterNote(body);
    $('#pick-att', body).onclick = (e) => {
      const seat = +e.target.dataset.seat; if (!seat) return;
      const set = this.absent(); set.has(seat) ? set.delete(seat) : set.add(seat);
      ls.set(this.absentKey(), [...set]); e.target.classList.toggle('off');
    };
    $('#pick-reset', body).onclick = (e) => { e.preventDefault(); ls.set(`picked.${this.key}.${today()}`, []); this.tab('pick'); };
    $('#pick-go', body).onclick = () => { this.quickPick(+$('#pick-n', body).value, $('#pick-ex', body).checked); this.tab('pick'); };
  }

  // 뽑기(빠른 도구에서도 씀): 오늘 뽑힌 학생은 빼고, 다 뽑았으면 안내
  async quickPick(n = 1, exclude = true) {
    if (!this.students.length) await this.loadRoster();
    const key = `picked.${this.key}.${today()}`;
    const picked = new Set(ls.get(key, []));
    let pool = this.present();
    if (exclude) pool = pool.filter((s) => !picked.has(s.seat));
    if (!pool.length) { this.toast('뽑을 학생이 없습니다. 수업 도구 → 뽑기에서 "처음부터"를 누르세요'); return; }
    const res = shuffle(pool).slice(0, n);
    res.forEach((s) => picked.add(s.seat));
    ls.set(key, [...picked]);
    const names = res.map((s) => this.label(s));
    const spin = this.present().map((s) => this.label(s));
    this.showPick(names, spin);
    this._emit({ kind: 'pick', names, spin });
  }

  quickDice(n = 2) {
    const vals = Array.from({ length: n }, () => 1 + rnd(6));
    this.showDice(vals, '6');
    this._emit({ kind: 'dice', vals, dkind: '6' });
  }

  showPick(names, spin, fromRemote = false) {
    this.sound('drum', fromRemote);
    this.ov.hidden = false;
    this.ov.innerHTML = `<div class="ct-card pick"><div class="ct-pick-names"></div><button type="button" class="ct-ov-close chip">닫기</button></div>`;
    const box = this.ov.querySelector('.ct-pick-names');
    const t0 = performance.now();
    const step = () => {
      const t = performance.now() - t0;
      if (t < 1250) {
        box.innerHTML = names.map(() => `<div class="spin">${esc(spin[rnd(spin.length)] || '')}</div>`).join('');
        setTimeout(step, 60 + t / 20);
      } else {
        box.innerHTML = names.map((n) => `<div class="final">${esc(n)}</div>`).join('');
        this.sound('fanfare', true);
      }
    };
    step();
  }

  hideOverlay(local) {
    this.ov.hidden = true; this.ov.innerHTML = '';
    if (local) this._emit({ kind: 'overlay-close' });
  }

  // ── 모둠 ──
  _pairUI(body, id, title, pairs, onChange) {
    const opts = this.students.map((s) => `<option value="${s.seat}">${esc(this.label(s))}</option>`).join('');
    const wrap = document.createElement('div');
    wrap.innerHTML = `<h4>${title}</h4><div class="ct-row"><select class="a">${opts}</select><select class="b">${opts}</select><button type="button" class="chip add">추가</button></div>
      <div class="ct-chips pairs">${pairs.map(([a, b], i) => `<button type="button" data-i="${i}">${esc(this.nameOf(a))} · ${esc(this.nameOf(b))} ✕</button>`).join('')}</div>`;
    wrap.querySelector('.add').onclick = () => {
      const a = +wrap.querySelector('.a').value, b = +wrap.querySelector('.b').value;
      if (a !== b) { pairs.push([a, b]); onChange(); }
    };
    wrap.querySelector('.pairs').onclick = (e) => { const i = e.target.dataset.i; if (i !== undefined) { pairs.splice(+i, 1); onChange(); } };
    wrap.id = id;
    body.appendChild(wrap);
  }
  nameOf(seat) { const s = this.students.find((x) => x.seat === seat); return s ? this.label(s) : `${seat}번`; }

  _groupsTab(body) {
    const cfg = ls.get(`groupcfg.${this.key}`, { by: 'count', n: 6, together: [], apart: [], leader: true });
    const redraw = () => { ls.set(`groupcfg.${this.key}`, cfg); this.tab('groups'); };
    body.innerHTML = `
      <div class="ct-row"><select id="g-by"><option value="count">모둠 수</option><option value="size">모둠당 인원</option></select>
        <input id="g-n" type="number" min="1" max="15" value="${cfg.n}"><label class="check"><input type="checkbox" id="g-lead" ${cfg.leader ? 'checked' : ''}> 모둠장 표시</label></div>
      <button type="button" class="ct-big" id="g-go">모둠 만들기</button>`;
    $('#g-by', body).value = cfg.by;
    $('#g-by', body).onchange = (e) => { cfg.by = e.target.value; ls.set(`groupcfg.${this.key}`, cfg); };
    $('#g-n', body).onchange = (e) => { cfg.n = Math.max(1, +e.target.value || 1); ls.set(`groupcfg.${this.key}`, cfg); };
    $('#g-lead', body).onchange = (e) => { cfg.leader = e.target.checked; ls.set(`groupcfg.${this.key}`, cfg); };
    this._pairUI(body, 'g-together', '같은 모둠으로', cfg.together, redraw);
    this._pairUI(body, 'g-apart', '다른 모둠으로', cfg.apart, redraw);
    this._savedList(body, 'groups', (item) => this.showGroups(item.result.groups, item.name));
    this._rosterNote(body);
    $('#g-go', body).onclick = () => {
      const seats = this.present().map((s) => s.seat);
      if (!seats.length) { this.toast('명단이 비어 있습니다'); return; }
      const { groups, violations } = makeGroups(seats, cfg.by === 'count' ? { count: cfg.n, ...cfg } : { size: cfg.n, ...cfg, count: 0 });
      const named = groups.map((g) => g.map((seat) => this.nameOf(seat)));
      if (violations) this.toast(`조건 ${violations}개는 지키지 못했습니다`);
      this.showGroups(named, '', cfg.leader);
      this._emit({ kind: 'groups', groups: named, leader: cfg.leader });
      this.lastGroups = { groups: named, leader: cfg.leader };
    };
  }

  showGroups(groups, title = '', leader = true, fromRemote = false) {
    if (!fromRemote) this.sound('bell', true);
    this.ov.hidden = false;
    this.ov.innerHTML = `<div class="ct-card wide"><header><h3>${esc(title || '모둠')}</h3>
      <div>${fromRemote ? '' : '<button type="button" class="chip" data-save>저장</button> '}<button type="button" class="chip ct-ov-close">닫기</button></div></header>
      <div class="ct-groups">${groups.map((g, i) => `<section><h4>${i + 1}모둠</h4>${g.map((n, j) => `<div>${j === 0 && leader ? '★ ' : ''}${esc(n)}</div>`).join('')}</section>`).join('')}</div></div>`;
    const sv = this.ov.querySelector('[data-save]');
    if (sv) sv.onclick = () => this._save('groups', { groups, leader });
  }

  // ── 자리 배치 ──
  _seatTab(body) {
    const cfg = ls.get(`seatcfg.${this.key}`, { rows: 5, cols: 6, empty: [], front: [], apart: [], fixed: {}, deskTop: true });
    const save = () => ls.set(`seatcfg.${this.key}`, cfg);
    // 빈자리는 인원수에 맞춰 자동으로(뒷줄 끝부터). 칸을 직접 누르면 그때부터는 손으로 정한 대로.
    const auto = () => { cfg.empty = autoEmpty(cfg.rows, cfg.cols, this.students.length, cfg.deskTop); cfg.autoEmpty = true; };
    if (cfg.autoEmpty !== false && cfg.empty.length !== Math.max(0, cfg.rows * cfg.cols - this.students.length)) auto();
    const redraw = () => { save(); this.tab('seat'); };
    body.innerHTML = `
      <div class="ct-row"><label>줄 <input id="s-r" type="number" min="1" max="10" value="${cfg.rows}"></label>
        <label>칸 <input id="s-c" type="number" min="1" max="10" value="${cfg.cols}"></label>
        <label class="check"><input type="checkbox" id="s-top" ${cfg.deskTop ? 'checked' : ''}> 칠판을 위에</label></div>
      <p class="muted small">빈자리: 칸을 눌러 바꿈 (${cfg.rows * cfg.cols - cfg.empty.length}자리 / ${this.students.length}명)${cfg.autoEmpty === false ? ' · <button type="button" class="linkish" id="s-auto">인원수에 맞추기</button>' : ''}</p>
      ${cfg.deskTop ? '<div class="ct-desk sm">칠판</div>' : ''}
      <div class="ct-seatmap" style="grid-template-columns:repeat(${cfg.cols},1fr)">${Array.from({ length: cfg.rows * cfg.cols }, (_, i) => {
        const k = `${Math.floor(i / cfg.cols)}-${i % cfg.cols}`;
        return `<button type="button" data-k="${k}" class="${cfg.empty.includes(k) ? 'off' : ''}">${cfg.fixed[k] ? esc(this.nameOf(cfg.fixed[k])) : ''}</button>`;
      }).join('')}</div>
      ${cfg.deskTop ? '' : '<div class="ct-desk sm">칠판</div>'}
      <button type="button" class="ct-big" id="s-go">자리 바꾸기</button>
      <h4>앞자리 (눈·키 등)</h4>
      <div class="ct-chips" id="s-front">${this.students.map((s) => `<button type="button" class="${cfg.front.includes(s.seat) ? 'on' : ''}" data-seat="${s.seat}">${esc(this.label(s))}</button>`).join('')}</div>`;
    $('#s-r', body).onchange = (e) => { cfg.rows = Math.max(1, Math.min(10, +e.target.value)); cfg.fixed = {}; auto(); redraw(); };
    $('#s-c', body).onchange = (e) => { cfg.cols = Math.max(1, Math.min(10, +e.target.value)); cfg.fixed = {}; auto(); redraw(); };
    $('#s-top', body).onchange = (e) => { cfg.deskTop = e.target.checked; if (cfg.autoEmpty !== false) auto(); redraw(); };
    const sa = $('#s-auto', body); if (sa) sa.onclick = () => { auto(); redraw(); };
    body.querySelector('.ct-seatmap').onclick = (e) => {
      const k = e.target.dataset.k; if (!k) return;
      cfg.empty = cfg.empty.includes(k) ? cfg.empty.filter((x) => x !== k) : [...cfg.empty, k];
      cfg.autoEmpty = false;
      delete cfg.fixed[k]; redraw();
    };
    $('#s-front', body).onclick = (e) => {
      const seat = +e.target.dataset.seat; if (!seat) return;
      cfg.front = cfg.front.includes(seat) ? cfg.front.filter((x) => x !== seat) : [...cfg.front, seat]; redraw();
    };
    this._pairUI(body, 's-apart', '떨어져 앉기', cfg.apart, redraw);
    this._savedList(body, 'seating', (item) => this.showSeating(item.result, item.name));
    this._rosterNote(body);
    $('#s-go', body).onclick = () => {
      const seats = this.present().map((s) => s.seat);
      const capacity = cfg.rows * cfg.cols - cfg.empty.length;
      if (seats.length > capacity) { this.toast(`자리가 ${seats.length - capacity}개 모자랍니다`); return; }
      const { seats: map, violations } = makeSeating(seats, cfg);
      if (violations) this.toast(`조건 ${violations}개는 지키지 못했습니다`);
      const named = Object.fromEntries(Object.entries(map).map(([k, s]) => [k, this.nameOf(s)]));
      const result = { rows: cfg.rows, cols: cfg.cols, empty: cfg.empty, deskTop: cfg.deskTop, seats: named };
      this.showSeating(result);
      this._emit({ kind: 'seating', result });
    };
  }

  showSeating(result, title = '', fromRemote = false) {
    this.seating = JSON.parse(JSON.stringify(result));
    const draw = () => {
      const { rows, cols, empty, deskTop, seats } = this.seating;
      const desk = `<div class="ct-desk">칠판</div>`;
      let cells = '';
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        const k = `${r}-${c}`;
        cells += empty.includes(k) ? '<div class="empty"></div>' : `<button type="button" data-k="${k}" class="${this._swap === k ? 'sel' : ''}">${esc(seats[k] || '')}</button>`;
      }
      this.ov.hidden = false;
      this.ov.innerHTML = `<div class="ct-card wide"><header><h3>${esc(title || '자리 배치')}</h3>
        <div><span class="muted small">두 자리를 누르면 서로 바뀝니다</span> ${fromRemote ? '' : '<button type="button" class="chip" data-save>저장</button>'} <button type="button" class="chip ct-ov-close">닫기</button></div></header>
        ${deskTop ? desk : ''}<div class="ct-seats" style="grid-template-columns:repeat(${cols},1fr)">${cells}</div>${deskTop ? '' : desk}</div>`;
      this.ov.querySelector('.ct-seats').onclick = (e) => {
        const k = e.target.dataset.k; if (!k) return;
        if (!this._swap) { this._swap = k; draw(); return; }
        const s = this.seating.seats; [s[this._swap], s[k]] = [s[k], s[this._swap]];
        this._swap = null; draw();
        this._emit({ kind: 'seating', result: this.seating, title });
      };
      const sv = this.ov.querySelector('[data-save]');
      if (sv) sv.onclick = () => this._save('seating', this.seating);
    };
    this._swap = null;
    draw();
  }

  async _save(kind, result) {
    const k = this.getClass();
    const d = new Date();
    const name = await askText('저장할 이름', `${kind === 'groups' ? '모둠' : '자리'} ${d.getMonth() + 1}/${d.getDate()}`);
    if (!name) return;
    try {
      const t = this.net.lastToken || await this.net.token();
      const r = await fetch('/eboard-api/arrangements', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t },
        body: JSON.stringify({ grade: k.grade, class: k.class, kind, name, result }),
      });
      this.toast(r.ok ? '저장했습니다' : '저장하지 못했습니다');
    } catch { this.toast('저장하지 못했습니다'); }
  }

  async _savedList(body, kind, onOpen) {
    const box = document.createElement('div');
    box.innerHTML = '<h4>저장한 것</h4><div class="ct-chips saved"><span class="muted small">불러오는 중…</span></div>';
    body.appendChild(box);
    try {
      const k = this.getClass();
      const t = this.net.lastToken || await this.net.token();
      const r = await fetch(`/eboard-api/arrangements?grade=${k.grade}&class=${k.class}&kind=${kind}`, { headers: { Authorization: 'Bearer ' + t } });
      const j = await r.json();
      const list = box.querySelector('.saved');
      list.innerHTML = j.items.length ? '' : '<span class="muted small">없음</span>';
      for (const it of j.items.slice(0, 8)) {
        const b = document.createElement('button');
        b.type = 'button'; b.textContent = it.name || it.created_at;
        b.onclick = () => { onOpen(it); this._emit({ kind: kind === 'groups' ? 'groups' : 'seating', groups: it.result.groups, leader: it.result.leader, result: it.result, title: it.name }); };
        list.appendChild(b);
      }
    } catch { box.querySelector('.saved').innerHTML = '<span class="muted small">불러오지 못했습니다</span>'; }
  }

  // ── 타이머 ──
  _timerTab(body) {
    body.innerHTML = `
      <div class="ct-presets">${[1, 3, 5, 10].map((m) => `<button type="button" data-m="${m}">${m}분</button>`).join('')}</div>
      <div class="ct-row"><input id="t-m" type="number" min="0" max="99" value="2"> 분 <input id="t-s" type="number" min="0" max="59" value="0"> 초
        <button type="button" class="chip" id="t-start">시작</button></div>
      <div class="ct-row"><button type="button" class="chip" id="t-sw">스톱워치</button><button type="button" class="chip" id="t-pause">멈춤/계속</button><button type="button" class="chip" id="t-stop">끄기</button></div>`;
    body.querySelector('.ct-presets').onclick = (e) => { const m = +e.target.dataset.m; if (m) this.startTimer(m * 60000); };
    $('#t-start', body).onclick = () => this.startTimer(((+$('#t-m', body).value || 0) * 60 + (+$('#t-s', body).value || 0)) * 1000);
    $('#t-sw', body).onclick = () => this.startTimer(0, 'up');
    $('#t-pause', body).onclick = () => this.pauseTimer();
    $('#t-stop', body).onclick = () => this.stopTimer();
  }

  startTimer(ms, mode = 'down', fromRemote = false) {
    if (mode === 'down' && ms <= 0) return;
    const now = Date.now();
    this.timer = { mode, endAt: now + ms, startAt: now - (mode === 'up' ? ms : 0), paused: false, remain: ms, rang: false };
    if (!fromRemote) this._emit({ kind: 'timer', action: 'start', ms, mode });
    this._tick();
  }
  pauseTimer(fromRemote = false, state) {
    const t = this.timer; if (!t) return;
    if (state) {
      t.paused = state.paused; t.remain = state.remain;
      if (!t.paused) { if (t.mode === 'down') t.endAt = Date.now() + t.remain; else t.startAt = Date.now() - t.remain; }
    } else if (!t.paused) { t.paused = true; t.remain = t.mode === 'down' ? t.endAt - Date.now() : Date.now() - t.startAt; }
    else { t.paused = false; if (t.mode === 'down') t.endAt = Date.now() + t.remain; else t.startAt = Date.now() - t.remain; }
    if (!fromRemote) this._emit({ kind: 'timer', action: 'pause', state: { paused: t.paused, remain: t.remain } });
    this._tick();
  }
  stopTimer(fromRemote = false) {
    this.timer = null; this.tw.hidden = true; this.tw.classList.remove('big', 'done');
    if (!fromRemote) this._emit({ kind: 'timer', action: 'stop' });
  }
  _tick() {
    clearTimeout(this._tt);
    const t = this.timer; if (!t) return;
    const ms = t.paused ? t.remain : (t.mode === 'down' ? t.endAt - Date.now() : Date.now() - t.startAt);
    const left = Math.max(0, ms), sec = Math.ceil(left / 1000);
    const txt = `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
    this.tw.hidden = false;
    this.tw.querySelector('.t-txt').textContent = txt;
    this.tw.querySelector('.t-x').textContent = '✕';
    this.tw.classList.toggle('paused', t.paused);
    this.tw.classList.toggle('warn', t.mode === 'down' && left <= 10000 && left > 0);
    if (t.mode === 'down' && left <= 0) {
      this.tw.classList.add('done');
      this.tw.querySelector('.t-txt').textContent = '끝!';
      this.tw.querySelector('.t-x').textContent = '닫기';
      if (!t.rang) { t.rang = true; this.sound('alarm', true); }
      return;
    }
    if (!t.paused) this._tt = setTimeout(() => this._tick(), 250);
  }

  // ── 주사위 ──
  _diceTab(body) {
    body.innerHTML = `
      <div class="ct-row"><label>개수 <select id="d-n"><option>1</option><option selected>2</option><option>3</option></select></label>
        <label>종류 <select id="d-kind"><option value="6">주사위(1~6)</option><option value="range">숫자 범위</option></select></label></div>
      <div class="ct-row" id="d-range" hidden><input id="d-a" type="number" value="1"> ~ <input id="d-b" type="number" value="30"></div>
      <button type="button" class="ct-big" id="d-go">굴리기</button>`;
    $('#d-kind', body).onchange = (e) => { $('#d-range', body).hidden = e.target.value !== 'range'; };
    $('#d-go', body).onclick = () => {
      const n = +$('#d-n', body).value, kind = $('#d-kind', body).value;
      const a = Math.min(+$('#d-a', body).value, +$('#d-b', body).value), b = Math.max(+$('#d-a', body).value, +$('#d-b', body).value);
      const vals = Array.from({ length: n }, () => (kind === '6' ? 1 + rnd(6) : a + rnd(b - a + 1)));
      this.showDice(vals, kind);
      this._emit({ kind: 'dice', vals, dkind: kind });
    };
  }

  showDice(vals, kind, fromRemote = false) {
    this.sound('drum', fromRemote);
    this.ov.hidden = false;
    this.ov.innerHTML = `<div class="ct-card"><div class="ct-dice"></div><div class="ct-dice-sum muted"></div><button type="button" class="chip ct-ov-close">닫기</button></div>`;
    const box = this.ov.querySelector('.ct-dice');
    const face = (v) => (kind === '6' ? `<div class="die d${v}">${'<i></i>'.repeat(v)}</div>` : `<div class="die num">${v}</div>`);
    const t0 = performance.now();
    const step = () => {
      if (performance.now() - t0 < 1000) {
        box.innerHTML = vals.map(() => face(kind === '6' ? 1 + rnd(6) : vals[0])).join('');
        box.classList.add('rolling'); setTimeout(step, 80);
      } else {
        box.classList.remove('rolling');
        box.innerHTML = vals.map(face).join('');
        if (vals.length > 1) this.ov.querySelector('.ct-dice-sum').textContent = `합 ${vals.reduce((x, y) => x + y, 0)}`;
      }
    };
    step();
  }

  // ── 소리 ──
  _soundTab(body) {
    body.innerHTML = `<div class="ct-sounds">${SOUND_LIST.map((s) => `<button type="button" data-id="${s.id}">${s.label}</button>`).join('')}</div>
      <p class="muted small">전자칠판이 연결되어 있으면 전자칠판 스피커로 소리가 납니다.</p>`;
    body.querySelector('.ct-sounds').onclick = (e) => { const id = e.target.dataset.id; if (id) this.sound(id); };
  }

  // ── 다른 기기에서 온 이벤트 ──
  onRemote(d) {
    switch (d.kind) {
      case 'sound': this.sound(d.id, true); break;
      case 'pick': this.showPick(d.names, d.spin, true); break;
      case 'dice': this.showDice(d.vals, d.dkind, true); break;
      case 'groups': this.showGroups(d.groups, d.title, d.leader !== false, true); break;
      case 'seating': this.showSeating(d.result, d.title, true); break;
      case 'overlay-close': this.hideOverlay(false); break;
      case 'timer':
        if (d.action === 'start') this.startTimer(d.ms, d.mode, true);
        else if (d.action === 'pause') this.pauseTimer(true, d.state);
        else if (d.action === 'stop') this.stopTimer(true);
        break;
    }
  }
}
