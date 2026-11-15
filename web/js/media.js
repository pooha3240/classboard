// 배경 자료: 사진·PDF 올리기, 최근 자료, 웹캠(이 기기 카메라) 캡처, 끌어다 놓기·붙여넣기
// 올린 파일은 서버가 webp 로 바꿔 보관합니다. 페이지 배경은 page:bg / page:import 로 모든 교사 기기에 함께 바뀝니다.
import { isImageBg, BOARD_WHITE, BOARD_GREEN, pageColor } from './shapes.js';
import { sha256Hex, convertImage, openPdf } from './convert.js';

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ls = {
  get(k, d) { try { const v = localStorage.getItem('eboard.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('eboard.' + k, JSON.stringify(v)); } catch { /* 무시 */ } },
};
const ACCEPT = 'image/*,.heic,.heif,.pdf,application/pdf';   // 기본판: 동영상 파일은 받지 않음(유튜브 주소로)
const KIND_LABEL = { pdf: 'PDF', image: '사진', capture: '웹캠', video: '동영상' };
const MB = 1024 * 1024;
const isVideoFile = (f) => /^video\//.test(f.type || '') || /\.(mp4|m4v|mov|webm)$/i.test(f.name || '');
export const YT_EMBED = /^https:\/\/www\.youtube\.com\/embed\/([\w-]{11})(?:\?start=(\d+))?$/;

// 올리기 전에 이 기기에서 열어 봄: 재생 가능한지, 화면 크기, 미리보기 그림(첫 장면 근처)
export function probeVideo(file) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    const url = URL.createObjectURL(file);
    let done = false;
    const finish = (r) => { if (done) return; done = true; URL.revokeObjectURL(url); v.removeAttribute('src'); v.load(); resolve(r); };
    v.muted = true; v.playsInline = true; v.preload = 'auto';
    v.onerror = () => finish(null);
    v.onloadedmetadata = () => {
      if (!v.videoWidth) { finish({ w: 0, h: 0, dur: v.duration, thumb: null }); return; }   // 소리만 있는 파일
      v.currentTime = Math.min(1, (v.duration || 2) / 3);
    };
    v.onseeked = () => {
      const c = document.createElement('canvas'), k = Math.min(1, 480 / v.videoWidth);
      c.width = Math.round(v.videoWidth * k); c.height = Math.round(v.videoHeight * k);
      try { c.getContext('2d').drawImage(v, 0, 0, c.width, c.height); } catch { /* 무시 */ }
      c.toBlob((b) => finish({ w: v.videoWidth, h: v.videoHeight, dur: v.duration, thumb: b }), 'image/webp', 0.8);
    };
    setTimeout(() => finish(null), 15000);
    v.src = url;
  });
}


// 사진·PDF 를 이 기기에서 바꿔 올림(서버는 보관만). 진도표 화면에서도 씀.
// onProgress(pct, text). 성공하면 {kind, name, items}, 실패하면 Error 를 던짐.
const HOW = {
  ppt: 'PowerPoint: 파일 → 내보내기 → PDF/XPS 만들기', pptx: 'PowerPoint: 파일 → 내보내기 → PDF/XPS 만들기',
  hwp: '한글: 파일 → PDF로 저장하기', hwpx: '한글: 파일 → PDF로 저장하기',
  doc: 'Word: 파일 → 다른 이름으로 저장 → PDF', docx: 'Word: 파일 → 다른 이름으로 저장 → PDF',
  xls: 'Excel: 파일 → 내보내기 → PDF/XPS 만들기', xlsx: 'Excel: 파일 → 내보내기 → PDF/XPS 만들기',
  key: 'Keynote: 파일 → 보내기 → PDF', odp: '파일 → PDF로 내보내기', odt: '파일 → PDF로 내보내기',
};
export async function uploadFile(file, { kind = 'file', token, onProgress = () => {} }) {
  const ext = (String(file.name || '').match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase();
  if (HOW[ext]) throw new Error(`${ext.toUpperCase()} 파일은 PDF로 저장해서 올려 주세요 (${HOW[ext]})`);
  if (isVideoFile(file)) throw new Error('기본판에서는 동영상 파일을 올릴 수 없습니다. 유튜브(일부 공개)에 올려 주소로 띄워 주세요');
  if (file.size > 100 * MB) throw new Error('파일이 너무 큽니다 (최대 100MB)');
  const isPdf = file.type === 'application/pdf' || ext === 'pdf';
  const akind = isPdf ? 'pdf' : (kind === 'capture' ? 'capture' : 'image');
  const name = file.name || '';
  const label = kind === 'capture' ? '캡처' : (name || '그림');
  const api = async (path) => {
    const r = await fetch('/eboard-api' + path, { headers: { Authorization: 'Bearer ' + token } });
    return r.ok ? r.json() : null;
  };
  onProgress(0, `${label} 여는 중…`);
  let pdf = null;
  try {
    const buf = await file.arrayBuffer();
    let sha = '';
    if (akind !== 'capture') {                       // 같은 파일을 전에 올렸으면 그대로 다시 씀
      sha = await sha256Hex(buf);
      const f = await api(`/media/find?sha=${sha}&kind=${akind}`).catch(() => null);
      if (f && f.items) { onProgress(100, '전에 올린 자료를 다시 씁니다'); return f; }
    }
    let n = 1, getPage;
    if (isPdf) {
      pdf = await openPdf(buf);
      n = pdf.pages;
      if (n < 1) throw new Error('빈 PDF 입니다');
      if (n > 60) throw new Error(`PDF 가 ${n}쪽입니다. 60쪽 이하로 나눠 올려 주세요`);
      getPage = (i) => pdf.page(i);
    } else getPage = () => convertImage(file);
    const items = [];
    let set = 0;
    for (let i = 0; i < n; i++) {
      onProgress((i / n) * 100, n > 1 ? `${label} 바꿔서 올리는 중… ${i + 1}/${n}쪽` : `${label} 올리는 중…`);
      const pg = await getPage(i);
      const q = new URLSearchParams({ set: String(set), i: String(i), n: String(n), kind: akind, name, sha, w: String(pg.w), h: String(pg.h) });
      let r, j = {};
      for (let attempt = 0; attempt < 3; attempt++) {           // 학교망이 잠깐 끊겨도 한 쪽만 다시
        r = await fetch(`/eboard-api/media/upload?${q}`, {
          method: 'POST', headers: { Authorization: 'Bearer ' + token, 'x-thumb-len': String(pg.thumb.size) },
          body: new Blob([pg.thumb, pg.blob]),
        }).catch(() => null);
        if (r) { j = await r.json().catch(() => ({})); if (r.ok || r.status < 500) break; }
        await new Promise((res) => setTimeout(res, 800 * (attempt + 1)));
      }
      if (!r) throw new Error('네트워크 오류로 올리지 못했습니다');
      if (!r.ok) throw new Error((j.detail && j.detail.message) || `올리지 못했습니다 (${r.status})`);
      set = j.set;
      items.push(j.item);
    }
    onProgress(100, '완료');
    return { kind: akind, name, items };
  } finally { if (pdf) pdf.close(); }
}

export class MediaTools {
  constructor({ net, board, renderer, toast }) {
    this.net = net; this.board = board; this.r = renderer; this.toast = toast;
    this.busy = false;
    this.cam = { stream: null, mirror: ls.get('cam.mirror', false), size: ls.get('cam.size', 'small'), deviceId: ls.get('cam.device', '') };
    this._buildPanel();
    this._buildPicker();
    this._buildCam();
    this._bindDrop();
  }

  // ── 패널 ──
  _buildPanel() {
    const el = document.createElement('aside');
    el.id = 'media-panel'; el.className = 'math-panel media-panel'; el.hidden = true;
    el.innerHTML = `
      <header><strong>자료</strong><button type="button" class="ct-close" aria-label="닫기">✕</button></header>
      <div class="mp-body">
        <div class="md-lesson" id="md-lesson" hidden></div>
        <div class="md-board" id="md-board">
          <span class="md-board-l">칠판 색</span>
          <button type="button" class="bc" data-bc="${BOARD_WHITE}" style="--c:${BOARD_WHITE}">흰색</button>
          <button type="button" class="bc dark" data-bc="${BOARD_GREEN}" style="--c:${BOARD_GREEN}">칠판</button>
          <button type="button" class="bc pal" data-bc="pick" title="다른 색·스포이드">🎨 다른 색</button>
        </div>
        <button type="button" class="ct-big" id="md-open">사진·PDF 불러오기</button>
        <input type="file" id="md-file" accept="${ACCEPT}" hidden>
        <p class="muted small" id="md-hint">교사 PC 에서는 파일을 칠판에 끌어다 놓거나, 복사한 그림을 붙여넣기(Ctrl+V)해도 됩니다.</p>
        <div class="md-progress" id="md-progress" hidden><i></i><span></span></div>
        <div class="mp-grid two">
          <button type="button" id="md-cam">웹캠 켜기</button>
          <button type="button" id="md-clear">배경 지우기</button>
        </div>
        <p class="muted small" id="md-current"></p>
        <h4>웹페이지</h4>
        <form class="md-url" id="md-url-form" novalidate>
          <input type="text" id="md-url" placeholder="주소 (예: phet.colorado.edu, 유튜브 주소)" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="go">
          <button type="submit" class="chip">띄우기</button>
        </form>
        <div class="ct-chips" id="md-urls"></div>
        <div class="md-row2" id="md-grab-row">
          <button type="button" class="md-wide" id="md-live-screen">다른 탭 실시간으로 띄우기</button>
          <button type="button" class="md-wide" id="md-grab">한 장만 가져오기</button>
        </div>
        <p class="muted small">칠판 안에 띄울 수 없는 사이트(아이스크림처럼 로그인이 필요한 사이트, 빈 화면·거부 표시)는 크롬의 다른 탭에 열어 두고 고르세요. 실시간으로 띄우면 그 탭 화면이 움직이는 그대로 깔리고 그 위에 판서합니다.</p>
        <h4>최근 자료 <span class="muted small" id="md-usage"></span> <button type="button" class="link small" id="md-reload">새로 고침</button></h4>
        <div class="md-recent" id="md-recent"><p class="muted small">불러오는 중…</p></div>
      </div>`;
    document.body.appendChild(el);
    this.panel = el;
    $('.ct-close', el).onclick = () => { el.hidden = true; };
    $('#md-open', el).onclick = () => $('#md-file', el).click();
    $('#md-file', el).onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) this.uploadAndPick(f); };
    $('#md-cam', el).onclick = () => { el.hidden = true; this.openCam(); };
    $('#md-clear', el).onclick = () => this.clearBg();
    $('#md-reload', el).onclick = () => this.loadRecent();
    $('#md-url-form', el).onsubmit = (e) => { e.preventDefault(); this.openWeb($('#md-url', el).value); };
    $('#md-urls', el).onclick = (e) => {
      const d = e.target.closest('[data-del]');
      if (d) { ls.set('web.urls', ls.get('web.urls', []).filter((u) => u !== d.dataset.del)); this._renderUrls(); return; }
      const b = e.target.closest('[data-url]'); if (b) this.openWeb(b.dataset.url);
    };
    const grab = $('#md-grab', el);
    if (!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia)) $('#md-grab-row', el).hidden = true;   // 안드로이드 크롬 등
    $('#md-live-screen', el).onclick = () => this.liveScreen();
    grab.onclick = () => this.grabScreen();
    this._renderUrls();
    $('#md-recent', el).onclick = (e) => { const b = e.target.closest('[data-asset]'); if (b) this.openSet(+b.dataset.asset); };
    $('#md-board', el).onclick = (e) => {
      const b = e.target.closest('[data-bc]'); if (!b) return;
      if (b.dataset.bc !== 'pick') { this.setBoardColor(b.dataset.bc); return; }
      this.colorPicker.open(b, { kind: 'board', title: '칠판 색', current: pageColor(this.board.page), onPick: (c) => this.setBoardColor(c) });
    };
    $('#md-lesson', el).onclick = (e) => {
      const b = e.target.closest('[data-li]');
      if (b) this.useLessonItems(b.dataset.li === 'all' ? this.lessonItems : [this.lessonItems[+b.dataset.li]]);
    };
  }

  toggle() {
    this.panel.hidden = !this.panel.hidden;
    if (!this.panel.hidden) { this.sync(); this.loadRecent(); this.loadLesson(); }
  }

  // ── 칠판 배경색: 이 페이지와 이 반의 새 페이지(그림·PDF·웹 배경 페이지는 색이 보이지 않음) ──
  async setBoardColor(c) {
    const p = this.board.page;
    if (!p) return;
    const r = await this.net.call('page:color', { page_id: p.id, color: c === BOARD_WHITE ? null : c }).catch(() => null);
    if (!r || !r.ok) { this.toast('칠판 색을 바꾸지 못했습니다' + (r && r.error ? ` (${r.error})` : '')); return; }
    if (!['none', 'grid', 'dots', 'coord'].includes(p.bg_type || 'none')) this.toast('지금 페이지는 그림·웹 배경이라 색이 보이지 않습니다. 새 페이지부터 이 색으로 시작합니다', 4000);
  }

  // ── 이 시간 차시 자료(주간 진도 화면에서 미리 붙여 둔 것) ──
  async loadLesson() {
    const box = $('#md-lesson', this.panel), k = this.getClass && this.getClass();
    box.hidden = true;
    if (!k) return;
    try {
      const j = await this._api(`/plan/now?grade=${k.grade}&class=${k.class}`);
      this.lessonItems = j.items || [];
      if (!j.lesson && !this.lessonItems.length) return;
      const name = (m) => m.title || (m.kind === 'yt' ? '유튜브' : m.kind === 'web' ? m.url : m.kind === 'video' ? '동영상' : '자료');
      box.innerHTML = `<h4>이 시간 차시 자료</h4><p class="small">${esc(j.subject || '')} ${esc(j.lesson || '')}</p>
        ${this.lessonItems.length ? `<div class="md-recent">${this.lessonItems.map((m, i) => `<button type="button" class="md-file ${m.kind === 'video' ? 'video' : ''}" data-li="${i}">
          ${m.thumb ? `<img src="${m.thumb}" alt="">` : `<b class="md-ico">${m.kind === 'yt' ? '▶' : '🌐'}</b>`}<span><b>${esc(name(m))}</b><small>${m.kind === 'pages' ? `${m.count}쪽` : m.kind === 'video' ? '동영상' : m.kind === 'yt' ? '유튜브' : '웹페이지'} · 넣기</small></span></button>`).join('')}</div>
          ${this.lessonItems.length > 1 ? '<button type="button" class="chip" data-li="all">모두 새 페이지로 넣기</button>' : ''}`
          : '<p class="muted small">붙여 둔 자료가 없습니다. ⋯ 메뉴 → 주간 진도·차시 자료에서 미리 올려 둘 수 있습니다.</p>'}`;
      box.hidden = false;
    } catch { /* 진도표 없음 */ }
  }

  async useLessonItems(items) {
    for (const m of items) {
      if (!m) continue;
      if (m.kind === 'pages') await this.importPages(m.assets);
      else if (m.kind === 'video') await this.openVideo({ asset: m.asset });
      else if (m.kind === 'yt') await this.openVideo({ yt: m.yt, start: m.start || 0 });
      else if (m.kind === 'web') await this.openWeb(m.url);
    }
    this.panel.hidden = true;
  }

  sync() {
    const p = this.board.page, cur = $('#md-current', this.panel);
    if (p && isImageBg(p)) {
      const m = p.bg_meta;
      cur.textContent = `지금 배경: ${m.name || KIND_LABEL[p.bg_type] || '자료'}${m.page != null ? ` ${m.page + 1}쪽` : ''}`;
    } else if (p && p.bg_type === 'web') cur.textContent = `지금 배경: 웹페이지 ${p.bg_meta.url || ''}`;
    else if (p && p.bg_type === 'video') cur.textContent = `지금 배경: ${p.bg_meta.src === 'yt' ? '유튜브 동영상' : `동영상 ${p.bg_meta.name || ''}`} (아래 막대로 재생·멈춤)`;
    else cur.textContent = '';
    const pc = pageColor(p), basic = [BOARD_WHITE, BOARD_GREEN].includes(pc);
    this.panel.querySelectorAll('#md-board [data-bc]').forEach((b) => b.classList.toggle('on', b.dataset.bc === pc || (b.dataset.bc === 'pick' && !basic)));
    const pk = this.panel.querySelector('#md-board .pal');
    if (pk) pk.style.setProperty('--c', basic ? 'transparent' : pc);
    $('#md-clear', this.panel).disabled = !(p && p.bg_type && p.bg_type !== 'none');
  }

  async _token() { return this.net.lastToken || this.net.token(); }

  async _api(path) {
    const r = await fetch('/eboard-api' + path, { headers: { Authorization: 'Bearer ' + await this._token() } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((j.detail && j.detail.message) || 'HTTP ' + r.status);
    return j;
  }

  async loadRecent() {
    const box = $('#md-recent', this.panel);
    try {
      const j = await this._api('/media/recent');
      if (j.quota) { const f = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}GB` : `${Math.round(n / 1e6)}MB`); $('#md-usage', this.panel).textContent = `(${f(j.usage)} / ${f(j.quota)}, 넘치면 오래된 것부터 지움)`; }
      box.innerHTML = j.files.length ? j.files.map((f) => `
        <button type="button" class="md-file ${f.kind === 'video' ? 'video' : ''}" data-asset="${f.asset}">
          <img src="${f.thumb}" alt="" loading="lazy">
          <span><b>${esc(f.name || KIND_LABEL[f.kind])}</b><small>${KIND_LABEL[f.kind]}${f.kind === 'pdf' ? ` · ${f.pages}쪽` : ''} · ${esc(f.created)}</small></span>
        </button>`).join('') : '<p class="muted small">아직 올린 자료가 없습니다</p>';
      box.querySelectorAll('img').forEach((im) => im.addEventListener('error', () => im.classList.add('noimg'), { once: true }));
    } catch (e) { box.innerHTML = `<p class="muted small">불러오지 못했습니다 (${esc(e.message)})</p>`; }
  }

  async openSet(assetId) {
    try { this.showPicker(await this._api(`/media/${assetId}/set`)); } catch (e) { this.toast(e.message); }
  }

  // ── 올리기 ──
  _progress(pct, text) {
    const el = $('#md-progress', this.panel);
    el.hidden = pct == null;
    if (pct == null) return;
    $('i', el).style.width = `${pct}%`;
    $('span', el).textContent = text;
  }

  async upload(file, kind = 'file') {
    if (this.busy) { this.toast('앞의 파일을 올리는 중입니다'); return null; }
    this.busy = true;
    if (kind !== 'capture') this.panel.hidden = false;
    try {
      const res = await uploadFile(file, { kind, token: await this._token(), onProgress: (p, t) => this._progress(p, t) });
      setTimeout(() => this._progress(null), 800);
      return res;
    } catch (e) {
      this._progress(null);
      this.toast(e.message || '올리지 못했습니다', 5000);
      return null;
    } finally { this.busy = false; }
  }

  async uploadAndPick(file) {
    const res = await this.upload(file);
    if (res) { this.showPicker(res); this.loadRecent(); }
  }

  // ── 넣을 쪽 고르기 ──
  _buildPicker() {
    const el = document.createElement('div');
    el.className = 'ct-overlay'; el.id = 'md-picker'; el.hidden = true;
    el.innerHTML = `
      <div class="ct-card wide md-card">
        <header><h3 id="mdp-title"></h3><button type="button" class="ct-close" aria-label="닫기">✕</button></header>
        <div class="md-tools"><span class="muted" id="mdp-info"></span>
          <button type="button" class="chip" id="mdp-all">모두 선택</button><button type="button" class="chip" id="mdp-none">모두 해제</button></div>
        <div class="md-grid" id="mdp-grid"></div>
        <div class="md-actions">
          <button type="button" class="chip" id="mdp-bg">지금 페이지 배경으로</button>
          <button type="button" class="ct-big" id="mdp-new">새 페이지로 넣기</button>
        </div>
      </div>`;
    document.body.appendChild(el);
    this.picker = el;
    const close = () => { el.hidden = true; };
    $('.ct-close', el).onclick = close;
    el.addEventListener('pointerdown', (e) => { if (e.target === el) close(); });
    $('#mdp-grid', el).onclick = (e) => {
      const b = e.target.closest('[data-i]'); if (!b) return;
      b.classList.toggle('on'); this._pickSync();
    };
    $('#mdp-all', el).onclick = () => { el.querySelectorAll('[data-i]').forEach((b) => b.classList.add('on')); this._pickSync(); };
    $('#mdp-none', el).onclick = () => { el.querySelectorAll('[data-i]').forEach((b) => b.classList.remove('on')); this._pickSync(); };
    $('#mdp-new', el).onclick = () => {
      const ids = this._picked(); close();
      if (this.pickKind === 'video') this.openVideo({ asset: ids[0] }); else this.importPages(ids);
    };
    $('#mdp-bg', el).onclick = () => {
      const ids = this._picked(); close();
      if (this.pickKind === 'video') this.openVideo({ asset: ids[0] }, true); else this.setBg(ids[0]);
    };
  }

  _picked() { return [...this.picker.querySelectorAll('[data-i].on')].map((b) => +b.dataset.asset); }

  _pickSync() {
    const n = this._picked().length, total = this.picker.querySelectorAll('[data-i]').length;
    $('#mdp-info', this.picker).textContent = total > 1 ? `${total}쪽 중 ${n}쪽 선택` : '';
    $('#mdp-new', this.picker).disabled = !n;
    $('#mdp-new', this.picker).textContent = n > 1 ? `새 페이지 ${n}장으로 넣기` : '새 페이지로 넣기';
    $('#mdp-bg', this.picker).disabled = n !== 1;
  }

  showPicker(res) {
    const el = this.picker, many = res.items.length > 1;
    this.pickKind = res.kind;
    $('#mdp-title', el).textContent = res.name || KIND_LABEL[res.kind] || '자료';
    $('.md-tools', el).hidden = !many;
    $('#mdp-grid', el).classList.toggle('single', !many);
    $('#mdp-grid', el).innerHTML = res.items.map((it, i) => `
      <button type="button" class="md-thumb on" data-i="${i}" data-asset="${it.asset}">
        <img src="${many || res.kind === 'video' ? it.thumb : it.url}" alt="" loading="lazy">${many ? `<span>${i + 1}</span>` : ''}${res.kind === 'video' ? '<b class="md-play">▶</b>' : ''}
      </button>`).join('');
    $('#mdp-grid', el).querySelectorAll('img').forEach((im) => im.addEventListener('error', () => im.classList.add('noimg'), { once: true }));
    this._pickSync();
    el.hidden = false;
  }

  async importPages(ids) {
    if (!ids.length) return;
    this.net.flush();
    const r = await this.net.call('page:import', { assets: ids }).catch(() => null);
    if (!r || !r.ok) { this.toast('페이지로 넣지 못했습니다' + (r && r.error ? ` (${r.error})` : '')); return; }
    this.panel.hidden = true;
    this.toast(ids.length > 1 ? `새 페이지 ${ids.length}장을 넣었습니다` : '새 페이지에 넣었습니다');
  }

  async setBg(assetId) {
    if (!assetId || !this.board.page) return;
    const r = await this.net.call('page:bg', { page_id: this.board.page.id, bg_type: 'image', bg_meta: { asset: assetId } }).catch(() => null);
    if (!r || !r.ok) { this.toast('배경을 바꾸지 못했습니다'); return; }
    this.panel.hidden = true;
  }

  async clearBg() {
    if (!this.board.page) return;
    const r = await this.net.call('page:bg', { page_id: this.board.page.id, bg_type: 'none', bg_meta: {} }).catch(() => null);
    if (!r || !r.ok) this.toast('배경을 지우지 못했습니다');
  }

  // ── 웹페이지 ──
  static normalizeUrl(raw) {
    let u = String(raw || '').trim();
    if (!u) return null;
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    // https 칠판 안에는 http 페이지를 띄울 수 없음(크롬이 막음) → https 로
    if (location.protocol === 'https:') u = u.replace(/^http:\/\//i, 'https://');
    try { u = new URL(u).href; } catch { return null; }
    // 유튜브 주소는 칠판에 넣을 수 있는 embed 주소로
    const yt = u.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|live\/)|youtu\.be\/)([\w-]{11})/);
    if (yt) {
      const t = u.match(/[?&]t=(\d+)/);
      return `https://www.youtube.com/embed/${yt[1]}${t ? `?start=${t[1]}` : ''}`;
    }
    return /^https?:\/\/[^\s<>"'\\]{3,1000}$/.test(u) ? u : null;
  }

  _renderUrls() {
    const list = ls.get('web.urls', []);
    $('#md-urls', this.panel).innerHTML = list.map((u) => `<span class="url-chip"><button type="button" data-url="${esc(u)}" title="${esc(u)}">${esc(u.replace(/^https?:\/\/(www\.)?/, '').slice(0, 28))}</button><button type="button" class="del" data-del="${esc(u)}" aria-label="목록에서 지우기" title="목록에서 지우기">✕</button></span>`).join('');
  }

  // 빈 페이지면 그 페이지에, 아니면 새 페이지를 만들어서
  async _targetPage() {
    const p = this.board.page;
    if (p && !this.board.objs.size && (!p.bg_type || p.bg_type === 'none')) return p.id;
    this.net.flush();
    const before = p && p.id;
    const r = await this.net.call('page:new', {}).catch(() => null);
    if (!r || !r.ok) return null;
    for (let i = 0; i < 20 && this.board.page && this.board.page.id === before; i++) await new Promise((res) => setTimeout(res, 50));
    return this.board.page && this.board.page.id !== before ? this.board.page.id : null;
  }

  async openWeb(raw) {
    const url = MediaTools.normalizeUrl(raw);
    if (!url) { this.toast('웹페이지 주소를 확인하세요'); return; }
    const yt = url.match(YT_EMBED);
    if (yt) {                                  // 유튜브: 각 반이 직접 재생하고 진행 칠판이 재생·멈춤을 맞춤
      if (await this.openVideo({ yt: yt[1], start: +(yt[2] || 0) })) this._rememberUrl(url);
      return;
    }
    const pid = await this._targetPage();
    if (!pid) { this.toast('페이지를 만들지 못했습니다'); return; }
    const r = await this.net.call('page:bg', { page_id: pid, bg_type: 'web', bg_meta: { url } }).catch(() => null);
    if (!r || !r.ok) { this.toast('웹페이지를 띄우지 못했습니다' + (r && r.error ? ` (${r.error})` : '')); return; }
    this._rememberUrl(url);
    this.panel.hidden = true;
    this.toast("웹페이지를 띄웠습니다. 메뉴 막대의 '웹페이지 조작하기'로 누르고 움직일 수 있어요", 4000);
  }

  _rememberUrl(url) {
    const list = [url, ...ls.get('web.urls', []).filter((u) => u !== url)].slice(0, 8);
    ls.set('web.urls', list); this._renderUrls();
    $('#md-url', this.panel).value = '';
  }

  // 동영상 배경: {yt, start} 또는 {asset}. here = 지금 페이지에(아니면 빈 페이지나 새 페이지)
  async openVideo(meta, here = false) {
    const pid = here && this.board.page ? this.board.page.id : await this._targetPage();
    if (!pid) { this.toast('페이지를 만들지 못했습니다'); return false; }
    const r = await this.net.call('page:bg', { page_id: pid, bg_type: 'video', bg_meta: meta }).catch(() => null);
    if (!r || !r.ok) { this.toast('동영상을 띄우지 못했습니다' + (r && r.error ? ` (${r.error})` : '')); return false; }
    this.panel.hidden = true;
    this.toast('동영상을 띄웠습니다. 아래 막대로 재생하면 같은 칠판을 보는 기기(합반 참여 반 포함)에서 함께 재생됩니다', 4500);
    return true;
  }

  // 크롬의 다른 탭·창을 한 장 찍어 새 페이지로
  async grabScreen() {
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: 'browser' }, audio: false, selfBrowserSurface: 'exclude', surfaceSwitching: 'exclude' });
    } catch (e) {
      if (e.name !== 'NotAllowedError' && e.name !== 'AbortError') this.toast(`화면을 가져오지 못했습니다 (${e.name})`);
      return;
    }
    try {
      const v = document.createElement('video');
      v.muted = true; v.playsInline = true; v.srcObject = stream;
      await v.play();
      await new Promise((r) => setTimeout(r, 350));          // 첫 장면이 그려질 때까지
      const c = document.createElement('canvas');
      c.width = v.videoWidth; c.height = v.videoHeight;
      if (!c.width) throw new Error('empty');
      c.getContext('2d').drawImage(v, 0, 0);
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.94));
      const now = new Date();
      const res = await this.upload(new File([blob], `화면 ${now.getHours()}시 ${String(now.getMinutes()).padStart(2, '0')}분.jpg`, { type: 'image/jpeg' }), 'capture');
      if (res) await this.importPages([res.items[0].asset]);
    } catch { this.toast('화면을 가져오지 못했습니다'); } finally {
      stream.getTracks().forEach((t) => t.stop());
    }
  }

  // ── 끌어다 놓기·붙여넣기 (교사 PC) ──
  _bindDrop() {
    const stage = this.r.stage;
    const has = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    stage.addEventListener('dragover', (e) => { if (has(e)) { e.preventDefault(); stage.classList.add('drop'); } });
    stage.addEventListener('dragleave', () => stage.classList.remove('drop'));
    stage.addEventListener('drop', (e) => {
      stage.classList.remove('drop');
      if (!has(e)) return;
      e.preventDefault();
      const f = e.dataTransfer.files[0];
      if (f) this.uploadAndPick(f);
    });
    document.addEventListener('paste', (e) => {
      if (e.target.closest && e.target.closest('input, textarea, [contenteditable]')) return;
      const it = [...(e.clipboardData ? e.clipboardData.items : [])].find((x) => x.kind === 'file' && /^image\/|pdf/.test(x.type));
      if (!it) return;
      e.preventDefault();
      const f = it.getAsFile();
      if (f) this.uploadAndPick(f.name ? f : new File([f], '붙여넣은 그림.png', { type: f.type }));
    });
  }

  // ── 웹캠: 이 기기에 연결된 카메라 ──
  _buildCam() {
    const el = document.createElement('div');
    el.className = 'cam'; el.id = 'cam'; el.hidden = true;
    el.innerHTML = `
      <video playsinline muted autoplay></video>
      <div class="cam-bar">
        <select id="cam-dev" aria-label="카메라"></select>
        <button type="button" id="cam-mirror">좌우 반전</button>
        <button type="button" id="cam-size">크게</button>
        <button type="button" id="cam-live">실시간 배경</button>
        <button type="button" id="cam-shot-bg">이 페이지 배경으로</button>
        <button type="button" class="primary" id="cam-shot">찍어서 새 페이지</button>
        <button type="button" id="cam-close" aria-label="웹캠 닫기">✕</button>
      </div>`;
    document.body.appendChild(el);
    this.camEl = el;
    $('#cam-close', el).onclick = () => this.closeCam();
    $('#cam-mirror', el).onclick = () => { this.cam.mirror = !this.cam.mirror; ls.set('cam.mirror', this.cam.mirror); this._camSync(); };
    $('#cam-size', el).onclick = () => { this.cam.size = this.cam.size === 'small' ? 'large' : 'small'; ls.set('cam.size', this.cam.size); this._camSync(); };
    $('#cam-dev', el).onchange = (e) => { this.cam.deviceId = e.target.value; ls.set('cam.device', this.cam.deviceId); this.openCam(); };
    $('#cam-shot', el).onclick = () => this.capture('new');
    $('#cam-shot-bg', el).onclick = () => this.capture('bg');
    $('#cam-live', el).onclick = () => this.liveOn();
    // 실시간 배경 조작 막대
    const lb = document.createElement('div');
    lb.className = 'live-bar'; lb.hidden = true;
    lb.innerHTML = `<span class="live-dot"></span><b class="live-name">웹캠 배경</b>
      <button type="button" data-l="mirror">좌우 반전</button>
      <button type="button" data-l="next" title="지금 화면과 판서를 이 페이지에 남기고 새 페이지에서 계속">다음 장</button>
      <button type="button" data-l="off" class="off">끄기</button>`;
    document.body.appendChild(lb);
    this.liveBar = lb;
    lb.onclick = (e) => {
      const a = e.target.closest('[data-l]')?.dataset.l;
      if (a === 'off') this.liveOff(true);
      else if (a === 'next') this.liveNext();
      else if (a === 'mirror') {
        this.cam.mirror = !this.cam.mirror; ls.set('cam.mirror', this.cam.mirror); this._camSync();
        if (this.liveVideo) this.r.setLive(this.liveVideo, this.cam.mirror);
      }
    };
    this.liveVideo = null; this.livePage = null; this.remoteLive = null; this._switching = false;
  }

  // ── 실시간 웹캠 배경: 이 기기 영상 위에 판서, 페이지를 떠나거나 끌 때 마지막 장면을 배경으로 남김 ──
  async liveOn() {
    if (!this.cam.stream) { await this.openCam(); if (!this.cam.stream) return; }
    await this._liveStart(this.cam.stream, 'cam');
    this.camEl.hidden = true;
  }

  // ── 실시간 화면 배경: 크롬의 다른 탭(아이스크림 등 칠판 안에 못 띄우는 사이트)을 움직이는 그대로 깔고 판서 ──
  async liveScreen() {
    let stream;
    // 크롬은 공유를 시작하면 그 탭으로 넘어가는데, 칠판 탭에 그대로 남도록
    const ctl = typeof CaptureController === 'function' ? new CaptureController() : null;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: 'browser', frameRate: { ideal: 15, max: 30 } }, audio: false,
        selfBrowserSurface: 'exclude', surfaceSwitching: 'include',   // 크롬 위쪽 막대의 '대신 이 탭 공유'로 바꿀 수 있음
        ...(ctl ? { controller: ctl } : {}),
      });
      try { if (ctl && ctl.setFocusBehavior) ctl.setFocusBehavior('no-focus-change'); } catch { /* 지원 안 함 */ }
    } catch (e) {
      if (e.name !== 'NotAllowedError' && e.name !== 'AbortError') this.toast(`화면을 가져오지 못했습니다 (${e.name})`);
      return;
    }
    const track = stream.getVideoTracks()[0];
    track.addEventListener('ended', () => { if (this.liveKind === 'screen') this.liveOff(true); });   // 크롬의 '공유 중지'
    this.panel.hidden = true;
    await this._liveStart(stream, 'screen');
    this.toast('다른 탭 화면을 띄웠습니다. 그 사이트를 누를 때는 그 탭으로 가서 조작하고, 칠판 탭으로 돌아오면 바뀐 화면 위에 이어서 판서합니다', 6000);
  }

  async _liveStart(stream, kind) {
    if (this.liveVideo) await this.liveOff(true);
    this._switching = true;
    const pid = await this._targetPage();
    this._switching = false;
    if (!pid) { this.toast('페이지를 만들지 못했습니다'); if (kind === 'screen') stream.getTracks().forEach((t) => t.stop()); return; }
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.autoplay = true; v.srcObject = stream;
    try { await v.play(); } catch { /* 자동 재생 */ }
    this.liveVideo = v; this.livePage = pid; this.liveKind = kind; this.liveStream = kind === 'screen' ? stream : null;
    this.r.setLive(v, kind === 'cam' && this.cam.mirror);
    $('.live-name', this.liveBar).textContent = kind === 'screen' ? '화면 배경' : '웹캠 배경';
    this.liveBar.querySelector('[data-l="mirror"]').hidden = kind !== 'cam';
    this.liveBar.hidden = false;
    this._emitLive(true, pid);
  }

  _frame(v) {
    if (!v || !v.videoWidth) return Promise.resolve(null);
    const c = document.createElement('canvas');
    c.width = v.videoWidth; c.height = v.videoHeight;
    const ctx = c.getContext('2d');
    if (this.cam.mirror && this.liveKind === 'cam') { ctx.translate(c.width, 0); ctx.scale(-1, 1); }
    ctx.drawImage(v, 0, 0);
    return new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
  }

  async _freeze(blob, pageId) {
    if (!blob || !pageId) return;
    const now = new Date();
    const res = await this.upload(new File([blob], `${this.liveKind === 'screen' ? '화면' : '웹캠'} ${now.getHours()}시 ${String(now.getMinutes()).padStart(2, '0')}분.jpg`, { type: 'image/jpeg' }), 'capture');
    if (!res) return;
    const r = await this.net.call('page:bg', { page_id: pageId, bg_type: 'image', bg_meta: { asset: res.items[0].asset } }).catch(() => null);
    if (!r || !r.ok) this.toast('웹캠 장면을 남기지 못했습니다');
  }

  async liveOff(freeze = true) {
    const v = this.liveVideo, pid = this.livePage;
    if (!v) return;
    this.liveVideo = null; this.livePage = null;
    this.liveBar.hidden = true;
    const blob = freeze ? await this._frame(v) : null;
    this.r.setLive(null);
    v.srcObject = null; v.remove();
    if (this.liveKind === 'screen') { if (this.liveStream) this.liveStream.getTracks().forEach((t) => t.stop()); this.liveStream = null; }
    else this.closeCam();
    this._emitLive(false, pid);
    await this._freeze(blob, pid);
    this.liveKind = null;
  }

  // 지금 장면을 이 페이지에 남기고 새 페이지에서 실시간 배경을 이어감(실물화상기로 여러 장 보여 줄 때)
  async liveNext() {
    const v = this.liveVideo, pid = this.livePage;
    if (!v) return;
    const blob = await this._frame(v);
    this._switching = true;
    this.net.flush();
    const r = await this.net.call('page:new', {}).catch(() => null);
    for (let i = 0; i < 20 && this.board.page && this.board.page.id === pid; i++) await new Promise((res) => setTimeout(res, 50));
    this._switching = false;
    if (!r || !r.ok || !this.board.page || this.board.page.id === pid) { this.toast('새 페이지를 만들지 못했습니다'); return; }
    this.livePage = this.board.page.id;
    this._emitLive(false, pid);
    this._emitLive(true, this.livePage);
    this.r.requestMain();
    await this._freeze(blob, pid);
  }

  // app.js 가 페이지를 바꿀 때 부름: 실시간 배경 페이지를 떠나면 마지막 장면을 남기고 끔
  onPageChange(page) {
    if (this.livePage && page.id !== this.livePage && !this._switching) this.liveOff(true);
    page.camLive = this.remoteLive === page.id && !this.liveVideo;
  }

  _emitLive(on, page) {
    if (this.net.connected) this.net.socket.emit('tool:event', { kind: 'camlive', on, page });
  }

  onRemote(d) {
    if (d.kind !== 'camlive') return;
    this.remoteLive = d.on ? d.page : (this.remoteLive === d.page ? null : this.remoteLive);
    const p = this.board.page;
    if (p) { p.camLive = this.remoteLive === p.id && !this.liveVideo; this.r.requestMain(); }
  }

  _camSync() {
    const el = this.camEl;
    el.classList.toggle('mirror', this.cam.mirror);
    el.classList.toggle('large', this.cam.size === 'large');
    $('#cam-mirror', el).classList.toggle('on', this.cam.mirror);
    $('#cam-size', el).textContent = this.cam.size === 'large' ? '작게' : '크게';
  }

  async openCam() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { this.toast('이 브라우저에서는 카메라를 쓸 수 없습니다 (https 필요)'); return; }
    this._stopStream();
    const video = { width: { ideal: 1920 }, height: { ideal: 1080 } };
    if (this.cam.deviceId) video.deviceId = { exact: this.cam.deviceId };
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
    } catch (e) {
      if (this.cam.deviceId && (e.name === 'OverconstrainedError' || e.name === 'NotFoundError')) {
        this.cam.deviceId = ''; ls.set('cam.device', ''); return this.openCam();
      }
      this.toast(e.name === 'NotAllowedError' ? '카메라 권한이 거부되었습니다. 주소창의 카메라 아이콘에서 허용하세요' : `카메라를 켜지 못했습니다 (${e.name})`, 4500);
      return;
    }
    this.cam.stream = stream;
    const v = $('video', this.camEl);
    v.srcObject = stream;
    this.camEl.hidden = false;
    this._camSync();
    try {                                       // 권한을 받은 뒤에야 카메라 이름이 보입니다
      const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
      const cur = stream.getVideoTracks()[0]?.getSettings().deviceId;
      $('#cam-dev', this.camEl).innerHTML = devs.map((d, i) => `<option value="${esc(d.deviceId)}" ${d.deviceId === cur ? 'selected' : ''}>${esc(d.label || `카메라 ${i + 1}`)}</option>`).join('');
      $('#cam-dev', this.camEl).hidden = devs.length < 2;
    } catch { /* 무시 */ }
  }

  _stopStream() {
    if (this.cam.stream) this.cam.stream.getTracks().forEach((t) => t.stop());
    this.cam.stream = null;
  }

  closeCam() {
    this._stopStream();
    $('video', this.camEl).srcObject = null;
    this.camEl.hidden = true;
  }

  async capture(mode) {
    const v = $('video', this.camEl);
    if (!v.videoWidth) { this.toast('카메라 화면이 아직 없습니다'); return; }
    const c = document.createElement('canvas');
    c.width = v.videoWidth; c.height = v.videoHeight;
    const ctx = c.getContext('2d');
    if (this.cam.mirror) { ctx.translate(c.width, 0); ctx.scale(-1, 1); }   // 화면에 보이는 그대로
    ctx.drawImage(v, 0, 0);
    this.camEl.classList.add('flash'); setTimeout(() => this.camEl.classList.remove('flash'), 250);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
    if (!blob) { this.toast('캡처하지 못했습니다'); return; }
    const now = new Date();
    const name = `웹캠 ${now.getHours()}시 ${String(now.getMinutes()).padStart(2, '0')}분.jpg`;
    const res = await this.upload(new File([blob], name, { type: 'image/jpeg' }), 'capture');
    if (!res) return;
    if (mode === 'bg') await this.setBg(res.items[0].asset);
    else await this.importPages([res.items[0].asset]);
    if (this.cam.size === 'large') { this.cam.size = 'small'; this._camSync(); }   // 찍은 뒤 판서할 수 있게 작게
  }
}
