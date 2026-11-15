// 판서 기록: 날짜·교시별 목록, 페이지 보기, 판서 재생, PDF(인쇄) 저장
import { Board } from './model.js';
import { renderPageCanvas } from './render.js';
import { drawShape, drawBackground, loadBgImage, pageColor, inkColor } from './shapes.js';
import { api, needLogin, $, esc } from './auth.js';

const qs = new URLSearchParams(location.search);
let grade = +qs.get('grade') || null, cls = +qs.get('class') || null;
let month = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
month.setDate(1);

const WEEK = ['일', '월', '화', '수', '목', '금', '토'];
const fmtMonth = (d) => `${d.getFullYear()}년 ${d.getMonth() + 1}월`;
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

async function init() {
  try {
    const c = await api('/classes');
    const sel = $('#class-select');
    sel.innerHTML = c.classes.map((x) => `<option value="${x.grade}-${x.class}">${x.grade}학년 ${x.class}반</option>`).join('');
    if (!grade && c.classes.length) { grade = c.classes[0].grade; cls = c.classes[0].class; }
    if (grade && !c.classes.some((x) => x.grade === grade && x.class === cls)) {
      sel.insertAdjacentHTML('afterbegin', `<option value="${grade}-${cls}">${grade}학년 ${cls}반</option>`);
    }
    sel.value = `${grade}-${cls}`;
    sel.onchange = () => { [grade, cls] = sel.value.split('-').map(Number); loadList(); };
  } catch (e) {
    if (needLogin(e)) return;
    // 등록 전자칠판(PIN) 은 학급 목록 없이 자기 학급만
    $('#class-select').innerHTML = `<option>${grade}학년 ${cls}반</option>`;
  }
  $('#prev-month').onclick = () => { month.setMonth(month.getMonth() - 1); loadList(); };
  $('#next-month').onclick = () => { month.setMonth(month.getMonth() + 1); loadList(); };
  loadList();
}

async function loadList() {
  $('#month-label').textContent = fmtMonth(month);
  const end = new Date(month.getFullYear(), month.getMonth() + 1, 0);
  const list = $('#list');
  list.innerHTML = '<p class="muted">불러오는 중…</p>';
  let j;
  try { j = await api(`/history/sessions?grade=${grade}&class=${cls}&start=${ymd(month)}&end=${ymd(end)}`); } catch (e) {
    if (!needLogin(e)) list.innerHTML = `<p class="muted">${esc(e.message)}</p>`;
    return;
  }
  if (j.storage) {
    const mb = (n) => Math.round(n / 1e6);
    $('#storage').textContent = `저장 공간 ${mb(j.storage.db)}MB / ${mb(j.storage.budget)}MB (자료 ${mb(j.storage.media)}MB 포함) · 판서 재생은 ${60}일까지, 그 뒤에는 완성된 판서만 남습니다`;
  }
  if (!j.sessions.length) { list.innerHTML = '<p class="muted empty">이 달에는 판서 기록이 없습니다.</p>'; return; }
  const byDate = new Map();
  for (const s of j.sessions) { if (!byDate.has(s.date)) byDate.set(s.date, []); byDate.get(s.date).push(s); }
  list.innerHTML = '';
  for (const [d, items] of byDate) {
    const dt = new Date(d + 'T00:00:00');
    const sec = document.createElement('section');
    sec.className = 'day';
    sec.innerHTML = `<h2>${dt.getMonth() + 1}월 ${dt.getDate()}일 <span class="muted">${WEEK[dt.getDay()]}요일</span></h2><div class="cards"></div>`;
    const box = sec.querySelector('.cards');
    for (const s of items.sort((a, b) => (a.period_from ?? 0) - (b.period_from ?? 0))) {
      const b = document.createElement('button');
      b.className = 'card';
      b.innerHTML = `<div class="thumb">${s.thumb ? `<img src="${s.thumb}" alt="" loading="lazy">` : '<span class="muted">미리보기 없음</span>'}</div>
        <div class="meta"><strong>${esc(s.label)}</strong>${s.subject ? ` · ${esc(s.subject)}` : ''}
        ${s.lesson ? `<span class="small lesson">${esc(s.lesson)}</span>` : ''}
        <span class="muted">${s.pages}쪽 · ${esc(s.started_at)}</span></div>`;
      b.onclick = () => openSession(s.id);
      box.appendChild(b);
      if (!s.thumb && s.first_page) lazyThumb(b, s.first_page);
    }
    list.appendChild(sec);
  }
}

// 미리보기 그림이 없는 기록(예전 수업 등): 화면에 보일 때 첫 페이지를 이 기기에서 그림
const thumbObs = 'IntersectionObserver' in window ? new IntersectionObserver((es) => {
  for (const e of es) if (e.isIntersecting) { thumbObs.unobserve(e.target); e.target._draw(); }
}, { rootMargin: '200px' }) : null;
function lazyThumb(card, pageId) {
  card._draw = () => api(`/history/pages/${pageId}/state`).then(async (st) => {
    await loadBgImage(st);
    const c = renderPageCanvas(st.objs, st.w, st.h, 400, st);
    const box = card.querySelector('.thumb'); box.innerHTML = ''; box.appendChild(c);
  }).catch(() => {});
  if (thumbObs) thumbObs.observe(card); else card._draw();
}

// ── 세션 보기 ──
let cur = null;    // {session, pages}

async function openSession(id) {
  cur = await api(`/history/sessions/${id}`);
  const s = cur.session;
  $('#sess-title').textContent = `${s.date.slice(5).replace('-', '/')} ${s.label}${s.subject ? ' · ' + s.subject : ''}`;
  const grid = $('#sess-pages');
  grid.innerHTML = '';
  for (const p of cur.pages) {
    const b = document.createElement('button');
    b.className = 'card page';
    b.innerHTML = `<div class="thumb">${p.thumb ? `<img src="${p.thumb}" alt="">` : '<canvas></canvas>'}</div><div class="meta">${p.page_no}쪽</div>`;
    b.onclick = () => openPage(p);
    grid.appendChild(b);
    if (!p.thumb && (p.seq || p.bg)) {          // 스냅샷이 없는 페이지는 바로 그려서 보여줌
      api(`/history/pages/${p.id}/state`).then(async (st) => {
        await loadBgImage(st);
        const c = renderPageCanvas(st.objs, st.w, st.h, 400, st);
        b.querySelector('canvas').replaceWith(c);
      }).catch(() => {});
    }
  }
  $('#sess-continue').onclick = () => { location.href = `./?open=${s.id}`; };
  $('#sess-print').onclick = () => printSession();
  $('#sess-delete').onclick = async () => {
    if (!confirm('이 판서 기록을 삭제할까요? 되살릴 수 없습니다.')) return;
    try { await api(`/history/sessions/${s.id}`, { method: 'DELETE' }); } catch (e) { alert(e.message); return; }
    $('#session').close(); loadList();
  };
  $('#session').showModal();
}

// ── 페이지 보기와 판서 재생 ──
const player = { ops: [], times: [], total: 0, v: 0, idx: 0, speed: 4, playing: false, board: new Board(), page: null };

async function openPage(p) {
  const j = await api(`/history/pages/${p.id}/ops`);
  player.page = j.page;
  player.ops = j.ops;
  // 3초 넘는 공백은 0.3초로 줄여 재생
  let v = 0, prev = j.ops.length ? j.ops[0].t : 0;
  player.times = j.ops.map((o) => { const d = o.t - prev; prev = o.t; v += d > 3000 ? 300 : Math.max(0, d); return v; });
  player.total = v;
  $('#play').hidden = !j.replay || !j.ops.length;        // 오래된 기록은 재생 없이 완성된 판서만
  $('#seek').max = String(Math.max(1, Math.round(v)));
  seek(v);                       // 처음에는 완성된 모습
  $('#viewer-title').textContent = `${p.page_no}쪽`;
  $('#viewer').showModal();
  requestAnimationFrame(draw);
}

function seek(v) {
  player.v = Math.max(0, Math.min(player.total, v));
  player.board.load({ ...player.page, objs: [], seq: 0 });
  player.idx = 0;
  advance();
}

function advance() {
  let changed = false;
  while (player.idx < player.ops.length && player.times[player.idx] <= player.v) {
    player.board.apply(player.ops[player.idx++]);
    changed = true;
  }
  $('#seek').value = String(Math.round(player.v));
  $('#time-label').textContent = `${Math.round(player.v / 1000)}초 / ${Math.round(player.total / 1000)}초`;
  return changed;
}

function draw() {
  const cv = $('#viewer-canvas');
  const box = cv.parentElement.getBoundingClientRect();
  const { w, h } = player.page;
  const s = Math.min(box.width / w, box.height / h), dpr = devicePixelRatio || 1;
  cv.width = Math.round(w * s * dpr); cv.height = Math.round(h * s * dpr);
  cv.style.width = `${w * s}px`; cv.style.height = `${h * s}px`;
  const ctx = cv.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = pageColor(player.page); ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.setTransform(s * dpr, 0, 0, s * dpr, 0, 0);
  drawBackground(ctx, player.page, () => { if ($('#viewer').open) draw(); });
  for (const o of player.board.objs.values()) {
    if (o.t === 'shape') { drawShape(ctx, o, player.page); continue; }
    ctx.globalAlpha = o.tool === 'hl' ? 0.35 : 1;
    ctx.fillStyle = inkColor(o.c, player.page);
    ctx.fill(player.board.path(o));
  }
  ctx.globalAlpha = 1;
}

let last = 0;
function tick(ts) {
  if (!player.playing) return;
  const dt = last ? ts - last : 16;
  last = ts;
  player.v += dt * player.speed;
  if (advance()) draw();
  if (player.v >= player.total) { player.playing = false; $('#play').textContent = '▶ 재생'; return; }
  requestAnimationFrame(tick);
}

$('#play').onclick = () => {
  if (player.playing) { player.playing = false; $('#play').textContent = '▶ 재생'; return; }
  if (player.v >= player.total) { seek(0); draw(); }
  player.playing = true; last = 0;
  $('#play').textContent = '⏸ 멈춤';
  requestAnimationFrame(tick);
};
$('#seek').oninput = (e) => { player.playing = false; $('#play').textContent = '▶ 재생'; seek(+e.target.value); draw(); };
for (const b of document.querySelectorAll('.speed button')) {
  b.onclick = () => {
    player.speed = +b.dataset.speed;
    document.querySelectorAll('.speed button').forEach((x) => x.classList.toggle('on', x === b));
  };
}
$('#viewer').addEventListener('close', () => { player.playing = false; $('#play').textContent = '▶ 재생'; });
window.addEventListener('resize', () => { if ($('#viewer').open) draw(); });

// ── PDF 저장: 인쇄 창에서 'PDF로 저장' ──
async function printSession() {
  const area = $('#print-area');
  area.innerHTML = '';
  const s = cur.session;
  for (const p of cur.pages) {
    if (!p.seq && !p.bg) continue;
    let src = p.image;
    if (!src) {
      const st = await api(`/history/pages/${p.id}/state`);
      await loadBgImage(st);
      src = renderPageCanvas(st.objs, st.w, st.h, 1600, st).toDataURL('image/png');
    }
    const fig = document.createElement('figure');
    fig.innerHTML = `<img src="${src}" alt=""><figcaption>${esc(s.date)} ${esc(s.label)}${s.subject ? ' · ' + esc(s.subject) : ''} — ${p.page_no}쪽</figcaption>`;
    area.appendChild(fig);
  }
  await Promise.all([...area.querySelectorAll('img')].map((im) => (im.complete ? 0 : new Promise((r) => { im.onload = im.onerror = r; }))));
  window.print();
}

init();
