// 오늘 시간표: 메뉴 막대의 '2교시 · 수학'을 누르면 열림. 나이스는 그대로 두고 수업 순서만 바꿨을 때
// 두 시간을 눌러 맞바꾸면 진도(뒤 차시)·판서 이름·차시 자료가 그대로 따라옵니다. 바꾼 것은 나이스 시간표를 다시 받아도 유지.
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const DAYS = ['일', '월', '화', '수', '목', '금', '토'];

export class TodayPanel {
  constructor({ toast, getClass, canEdit, token, elevate, openMaterials }) {
    Object.assign(this, { toast, getClass, canEdit, token, elevate, openMaterials });
    this.sel = null; this.data = null;
    const el = document.createElement('div');
    el.className = 'ct-overlay'; el.id = 'today-panel'; el.hidden = true;
    el.innerHTML = `
      <div class="ct-card today-card">
        <header><h3 id="td-title">오늘 시간표</h3><button type="button" class="ct-close" aria-label="닫기">✕</button></header>
        <p class="muted small" id="td-help">수업 순서를 바꿨으면 두 시간을 차례로 누르고 '바꾸기'를 누르세요. 뒤 차시와 자료가 따라옵니다.</p>
        <div class="td-list" id="td-list"></div>
        <div class="td-meal" id="td-meal" hidden></div>
        <div class="td-bar" id="td-bar" hidden><span id="td-msg"></span><button type="button" class="chip" id="td-cancel">취소</button><button type="button" class="ct-big" id="td-swap">바꾸기</button></div>
        <div class="td-foot"><button type="button" class="chip" id="td-media" hidden>지금 차시 자료 열기</button><a class="chip" id="td-plan" href="plan.php">주간 진도에서 더 고치기 ›</a></div>
      </div>`;
    document.body.appendChild(el);
    this.el = el;
    $('.ct-close', el).onclick = () => this.close();
    el.addEventListener('pointerdown', (e) => { if (e.target === el) this.close(); });
    $('#td-list', el).onclick = (e) => this._pick(e.target.closest('[data-id]'));
    $('#td-cancel', el).onclick = () => { this.sel = null; this._draw(); };
    $('#td-swap', el).onclick = () => this._swap();
    $('#td-media', el).onclick = () => { this.close(); this.openMaterials(); };
  }

  close() { this.el.hidden = true; this.sel = null; }

  async _api(path, opts = {}, tok) {
    const r = await fetch('/eboard-api' + path, { ...opts, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (tok || await this.token()) } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error((j.detail && j.detail.message) || 'HTTP ' + r.status); e.code = j.detail && j.detail.error; throw e; }
    return j;
  }

  async open() {
    const k = this.getClass();
    if (!k) return;
    $('#td-plan', this.el).href = `plan.php?grade=${k.grade}&class=${k.class}`;
    try {
      this.data = await this._api(`/plan/today?grade=${k.grade}&class=${k.class}`);
    } catch (e) { this.toast(e.message); return; }
    if (!this.data.slots.length && !(this.data.meals && this.data.meals.length)) { this.toast('오늘 진도표가 없습니다. ⋯ 메뉴 → 주간 진도·차시 자료에서 나이스 진도표를 올려 주세요', 4500); return; }
    this.sel = null;
    this._draw();
    this.el.hidden = false;
  }

  _draw() {
    const d = this.data, now = d.period;
    const dt = new Date(d.date + 'T00:00:00');
    $('#td-title', this.el).textContent = `오늘 시간표 · ${dt.getMonth() + 1}/${dt.getDate()}(${DAYS[dt.getDay()]})`;
    const edit = this.canEdit();
    $('#td-help', this.el).hidden = !edit;
    $('#td-list', this.el).innerHTML = d.slots.map((s) => {
      const le = s.lesson;
      return `<button type="button" class="td-row ${s.period === now ? 'now' : ''} ${this.sel && this.sel.id === s.id ? 'sel' : ''} ${s.cancelled ? 'off' : ''}" data-id="${s.id}" ${edit ? '' : 'disabled'}>
        <span class="td-p">${s.period}${s.period === now ? '<small>지금</small>' : ''}</span>
        <span class="td-s"><b>${esc(s.subject)}</b>${le && le.no ? ` <span class="td-no">${le.no}/${le.total}</span>` : ''}${s.subject !== s.orig ? ` <small class="td-tag">원래 ${esc(s.orig)}</small>` : ''}
          <span class="td-t">${s.cancelled ? `없음${s.note ? ' · ' + esc(s.note) : ''}` : esc(le && le.topic ? le.topic : '')}</span></span>
        ${le && le.media ? `<span class="td-clip">📎${le.media}</span>` : ''}
      </button>`;
    }).join('');
    const meal = $('#td-meal', this.el), ms = d.meals || [];
    meal.hidden = !ms.length;
    meal.innerHTML = ms.map((m) => `<div class="td-mrow"><b>🍚 ${esc(m.type === '중식' ? '점심' : m.type)}</b>${m.kcal ? `<small class="muted">${esc(m.kcal)}</small>` : ''}
      <div class="td-dishes">${m.dishes.map((x) => `<span>${esc(x.name)}${x.allergy.length ? `<sup title="알레르기 유발 식품 번호">${x.allergy.join('.')}</sup>` : ''}</span>`).join('')}</div></div>`).join('');
    if (!d.slots.length) $('#td-list', this.el).innerHTML = '<p class="muted small">오늘 진도표가 없습니다.</p>';
    const bar = $('#td-bar', this.el);
    bar.hidden = !this.sel;
    if (this.sel) $('#td-msg', this.el).textContent = this.sel2 ? '' : `${this.sel.period}교시 ${this.sel.subject}와 바꿀 시간을 누르세요`;
    $('#td-swap', this.el).hidden = true;
    const cur = d.slots.find((s) => s.period === now);
    $('#td-media', this.el).hidden = !(cur && cur.lesson && cur.lesson.media);
  }

  _pick(b) {
    if (!b || !this.canEdit()) return;
    const s = this.data.slots.find((x) => x.id === +b.dataset.id);
    if (!this.sel || this.sel.id === s.id) { this.sel = this.sel && this.sel.id === s.id ? null : s; this.sel2 = null; this._draw(); return; }
    this.sel2 = s;
    this._draw();
    this.el.querySelector(`[data-id="${s.id}"]`).classList.add('sel');
    $('#td-msg', this.el).textContent = `${this.sel.period}교시 ${this.sel.subject} ↔ ${s.period}교시 ${s.subject}`;
    $('#td-swap', this.el).hidden = false;
  }

  async _swap() {
    const a = this.sel, b = this.sel2;
    if (!a || !b) return;
    const body = JSON.stringify({ a: a.id, b: b.id });
    try {
      try {
        await this._api('/plan/swap', { method: 'POST', body });
      } catch (e) {
        if (e.code !== 'pin_required') throw e;
        const tok = await this.elevate();                 // 등록 전자칠판: PIN 한 번(10분 유지)
        if (!tok) return;
        await this._api('/plan/swap', { method: 'POST', body }, tok);
      }
      this.toast(`${a.period}교시와 ${b.period}교시를 바꿨습니다. 나이스는 그대로이고, 진도와 판서 이름이 바뀝니다`, 4000);
      this.sel = this.sel2 = null;
      await this.open();
    } catch (e) { this.toast(e.message, 3500); }
  }
}
