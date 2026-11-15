// 아래 메뉴 막대의 '자주 쓰는 도구': 기기마다 골라 둔 버튼을 한 번에 실행
import { SOUND_LIST } from './sound.js';
import { BOARD_WHITE, BOARD_GREEN, isDarkPage } from './shapes.js';

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const KEY = 'eboard.quick';
const MAX = 10;
const DEFAULT = ['pick', 't3', 's-correct', 's-clap', 'ruler', 'protractor'];

// c: { classTools, mathTools, mediaTools, tools, renderer, board, clearPage, goPage }
function actions(c) {
  const list = [
    { id: 'pick', g: '수업 도구', label: '뽑기', run: () => c.classTools.quickPick(1) },
    { id: 'pick2', g: '수업 도구', label: '2명 뽑기', run: () => c.classTools.quickPick(2) },
    { id: 'dice', g: '수업 도구', label: '주사위', run: () => c.classTools.quickDice(2) },
    { id: 'call', g: '수업 도구', label: '호출', run: () => c.classTools.open('call') },
    { id: 'groups', g: '수업 도구', label: '모둠', run: () => c.classTools.open('groups') },
    { id: 'seat', g: '수업 도구', label: '자리', run: () => c.classTools.open('seat') },
    ...[1, 3, 5, 10].map((m) => ({ id: `t${m}`, g: '타이머', label: `${m}분`, run: () => c.classTools.startTimer(m * 60000) })),
    { id: 'sw', g: '타이머', label: '스톱워치', run: () => c.classTools.startTimer(0, 'up') },
    ...SOUND_LIST.map((s) => ({ id: `s-${s.id}`, g: '소리', label: s.label, run: () => c.classTools.sound(s.id) })),
    { id: 'ruler', g: '수학', label: '자', run: () => c.mathTools.toggleInstrument('ruler'), on: () => c.mathTools.instruments.has('ruler') },
    { id: 'set45', g: '수학', label: '삼각자 45°', run: () => c.mathTools.toggleInstrument('set45'), on: () => c.mathTools.instruments.has('set45') },
    { id: 'set60', g: '수학', label: '삼각자 60°', run: () => c.mathTools.toggleInstrument('set60'), on: () => c.mathTools.instruments.has('set60') },
    { id: 'protractor', g: '수학', label: '각도기', run: () => c.mathTools.toggleInstrument('protractor'), on: () => c.mathTools.instruments.has('protractor') },
    { id: 'grid', g: '수학', label: '모눈', run: () => c.mathTools.setBg('grid', true), on: () => c.board.page?.bg_type === 'grid' },
    { id: 'dots', g: '수학', label: '점판', run: () => c.mathTools.setBg('dots', true), on: () => c.board.page?.bg_type === 'dots' },
    { id: 'coord', g: '수학', label: '좌표평면', run: () => c.mathTools.setBg('coord', true), on: () => c.board.page?.bg_type === 'coord' },
    { id: 'boardc', g: '칠판', label: '초록 칠판', run: () => c.mediaTools.setBoardColor(isDarkPage(c.board.page) ? BOARD_WHITE : BOARD_GREEN), on: () => isDarkPage(c.board.page) },
    { id: 'white', g: '칠판', label: '흰 분필', run: () => { c.tools.color = '#ffffff'; c.tools.tool = 'pen'; c.sync(); }, on: () => c.tools.color === '#ffffff' },
    { id: 'hl', g: '칠판', label: '형광펜', run: () => { c.tools.tool = 'hl'; c.sync(); }, on: () => c.tools.tool === 'hl' },
    { id: 'erase', g: '칠판', label: '지우개', run: () => { c.tools.tool = 'erase'; c.sync(); }, on: () => c.tools.tool === 'erase' || c.tools.tool === 'erasePart' },
    { id: 'undo', g: '칠판', label: '되돌림', run: () => c.tools.undo() },
    { id: 'clear', g: '칠판', label: '전체 지우기', run: () => c.clearPage() },
    { id: 'fit', g: '칠판', label: '화면 맞춤', run: () => c.renderer.fit() },
    { id: 'history', g: '칠판', label: '판서 기록', run: () => c.goPage('history.html') },
    { id: 'media', g: '자료', label: '자료', run: () => c.mediaTools.toggle() },
    { id: 'cam', g: '자료', label: '웹캠', run: () => c.mediaTools.openCam() },
  ];
  if (navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) list.push({ id: 'grab', g: '자료', label: '화면 가져오기', run: () => c.mediaTools.grabScreen() });
  if (navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) list.push({ id: 'livetab', g: '자료', label: '다른 탭 띄우기', run: () => c.mediaTools.liveScreen() });
  return list;
}

export class QuickBar {
  constructor(ctx) {
    this.c = ctx;
    this.all = actions(ctx);
    this.byId = new Map(this.all.map((a) => [a.id, a]));
    this.ids = this._load();
    this.bar = $('#quickbar');
    this._buildEditor();
    this.render();
    setInterval(() => this.sync(), 1000);          // 다른 기기에서 자·배경을 바꾼 경우 등
    this.bar.onclick = (e) => {
      const b = e.target.closest('[data-q]');
      if (!b) return;
      if (b.dataset.q === '+') { this.edit(); return; }
      const a = this.byId.get(b.dataset.q);
      if (a) { a.run(); setTimeout(() => this.sync(), 120); }
    };
  }

  _load() {
    try {
      const v = JSON.parse(localStorage.getItem(KEY));
      if (Array.isArray(v)) return v.filter((id) => this.byId.has(id)).slice(0, MAX);
    } catch { /* 무시 */ }
    return DEFAULT.filter((id) => this.byId.has(id));
  }

  _save() { try { localStorage.setItem(KEY, JSON.stringify(this.ids)); } catch { /* 무시 */ } }

  render() {
    this.bar.innerHTML = this.ids.map((id) => `<button type="button" class="q-btn" data-q="${id}">${esc(this.byId.get(id).label)}</button>`).join('')
      + '<button type="button" class="q-btn q-add" data-q="+" title="자주 쓰는 도구 고르기" aria-label="자주 쓰는 도구 고르기">＋</button>';
    this.sync();
  }

  // 켜짐 상태(자·각도기·모눈 등) 표시
  sync() {
    this.bar.querySelectorAll('[data-q]').forEach((b) => {
      const a = this.byId.get(b.dataset.q);
      b.classList.toggle('on', !!(a && a.on && a.on()));
    });
  }

  _buildEditor() {
    const el = document.createElement('div');
    el.className = 'ct-overlay'; el.id = 'quick-editor'; el.hidden = true;
    el.innerHTML = `
      <div class="ct-card wide q-card">
        <header><h3>자주 쓰는 도구</h3><button type="button" class="ct-close" aria-label="닫기">✕</button></header>
        <p class="muted small">누른 순서대로 아래 막대에 놓입니다(최대 ${MAX}개). 다시 누르면 빠집니다. 이 기기에만 저장됩니다.</p>
        <div class="q-groups"></div>
        <div class="md-actions">
          <button type="button" class="chip" data-e="reset">기본값</button>
          <button type="button" class="chip" data-e="none">모두 빼기</button>
          <button type="button" class="ct-big" data-e="done">완료</button>
        </div>
      </div>`;
    document.body.appendChild(el);
    this.editor = el;
    const close = () => { el.hidden = true; };
    $('.ct-close', el).onclick = close;
    el.addEventListener('pointerdown', (e) => { if (e.target === el) close(); });
    el.onclick = (e) => {
      const q = e.target.closest('[data-pick]');
      if (q) {
        const id = q.dataset.pick, i = this.ids.indexOf(id);
        if (i >= 0) this.ids.splice(i, 1);
        else if (this.ids.length >= MAX) { this.c.toast(`최대 ${MAX}개까지 놓을 수 있습니다`); return; } else this.ids.push(id);
        this._save(); this.render(); this._renderEditor();
        return;
      }
      const a = e.target.closest('[data-e]')?.dataset.e;
      if (a === 'reset') this.ids = DEFAULT.filter((id) => this.byId.has(id));
      else if (a === 'none') this.ids = [];
      else if (a === 'done') { close(); return; } else return;
      this._save(); this.render(); this._renderEditor();
    };
  }

  _renderEditor() {
    const groups = [...new Set(this.all.map((a) => a.g))];
    $('.q-groups', this.editor).innerHTML = groups.map((g) => `
      <h4>${esc(g)}</h4>
      <div class="ct-chips">${this.all.filter((a) => a.g === g).map((a) => {
        const n = this.ids.indexOf(a.id);
        return `<button type="button" data-pick="${a.id}" class="${n >= 0 ? 'on' : ''}">${n >= 0 ? `<b class="q-n">${n + 1}</b>` : ''}${esc(a.label)}</button>`;
      }).join('')}</div>`).join('');
  }

  edit() { this._renderEditor(); this.editor.hidden = false; }
}
