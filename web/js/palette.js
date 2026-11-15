// 색 고르기 창: 자주 쓰는 색, 스포이드(화면 어디서나 색 집기), 직접 고르기, 최근에 고른 색
// 글씨 색과 칠판 배경색에 함께 씀. 어느 기기든 같은 모양(손가락으로 누르기 좋게 큰 칸)
const $ = (s, el = document) => el.querySelector(s);
const PRESETS = {
  ink: ['#1d1d1b', '#ffffff', '#5f6368', '#d7263d', '#ff6b6b', '#f08a00', '#ffd23f', '#a3d977', '#1e8a4c',
    '#00a6a6', '#4fc3f7', '#1b5fd1', '#283593', '#7b3fb5', '#e05fa8', '#8d5524'],
  board: ['#ffffff', '#f7f3e8', '#fff8d6', '#eef6ff', '#e9f5ec', '#24493a', '#2f5d50', '#1f3b4d', '#263238', '#1d1d1b',
    '#3e2c23', '#4a148c'],
};
const ls = {
  get(k, d) { try { const v = localStorage.getItem('eboard.' + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('eboard.' + k, JSON.stringify(v)); } catch { /* 저장 안 됨 */ } },
};
const norm = (c) => (/^#[0-9a-f]{6}$/i.test(c || '') ? c.toLowerCase() : null);

export class ColorPicker {
  constructor() {
    const el = document.createElement('div');
    el.className = 'cpick'; el.hidden = true;
    el.innerHTML = `
      <div class="cp-head"><b class="cp-title"></b><button type="button" class="cp-x" aria-label="닫기">✕</button></div>
      <div class="cp-grid"></div>
      <div class="cp-recent-wrap"><span class="muted small">최근</span><div class="cp-recent"></div></div>
      <div class="cp-tools">
        <button type="button" class="cp-eye" title="화면에서 색을 집어 옵니다(그림·웹페이지 위의 색도)">💧 스포이드</button>
        <label class="cp-custom">직접 고르기<input type="color" value="#1b5fd1"></label>
      </div>`;
    document.body.appendChild(el);
    this.el = el;
    this.onPick = null; this.kind = 'ink';
    $('.cp-x', el).onclick = () => this.close();
    el.addEventListener('pointerdown', (e) => e.stopPropagation());
    el.addEventListener('click', (e) => { const b = e.target.closest('[data-c]'); if (b) this._pick(b.dataset.c); });
    const eye = $('.cp-eye', el);
    if (!('EyeDropper' in window)) eye.hidden = true;           // 크롬 PC 에서만(태블릿 크롬은 아직 없음)
    eye.onclick = async () => {
      try {
        el.classList.add('picking');
        const r = await new window.EyeDropper().open();
        if (r && r.sRGBHex) this._pick(r.sRGBHex);
      } catch { /* 취소 */ } finally { el.classList.remove('picking'); }
    };
    $('.cp-custom input', el).addEventListener('change', (e) => this._pick(e.target.value));
    document.addEventListener('pointerdown', (e) => { if (!el.hidden && !el.contains(e.target) && e.target !== this.anchor) this.close(); });
  }

  open(anchor, { kind = 'ink', title = '색 고르기', current = null, onPick }) {
    this.anchor = anchor; this.kind = kind; this.onPick = onPick;
    $('.cp-title', this.el).textContent = title;
    const cur = norm(current);
    const sw = (c) => `<button type="button" class="cp-sw ${c === cur ? 'on' : ''}" data-c="${c}" style="--c:${c}" title="${c}" aria-label="${c}"></button>`;
    $('.cp-grid', this.el).innerHTML = PRESETS[kind].map(sw).join('');
    const recent = ls.get(`recent.${kind}`, []).filter((c) => !PRESETS[kind].includes(c));
    $('.cp-recent', this.el).innerHTML = recent.map(sw).join('');
    $('.cp-recent-wrap', this.el).hidden = !recent.length;
    if (cur) $('.cp-custom input', this.el).value = cur;
    this.el.hidden = false;
    // 누른 버튼 옆에(화면 밖으로 나가지 않게)
    const r = anchor.getBoundingClientRect(), w = this.el.offsetWidth, h = this.el.offsetHeight;
    let x = r.right + 10, y = r.bottom - h;
    if (x + w > innerWidth - 8) x = Math.max(8, r.left - w - 10);
    if (x < 8) x = 8;
    y = Math.min(Math.max(8, y), innerHeight - h - 8);
    if (r.top > innerHeight - 120 && r.left > 200) { x = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), innerWidth - w - 8); y = r.top - h - 10; }
    this.el.style.left = `${x}px`; this.el.style.top = `${Math.max(8, y)}px`;
  }

  close() { this.el.hidden = true; this.onPick = null; }

  _pick(c) {
    c = norm(c);
    if (!c) return;
    if (!PRESETS[this.kind].includes(c)) ls.set(`recent.${this.kind}`, [c, ...ls.get(`recent.${this.kind}`, []).filter((x) => x !== c)].slice(0, 8));
    const f = this.onPick;
    this.close();
    if (f) f(c);
  }
}
