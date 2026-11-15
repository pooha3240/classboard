// 교시 시각·학급 시간표 설정
import { api, needLogin, $, esc } from './auth.js';

const qs = new URLSearchParams(location.search);
let grade = +qs.get('grade') || null, cls = +qs.get('class') || null;
let bells = [];

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 2400);
}

function drawBells() {
  $('#bells').innerHTML = bells.map((b, i) => `<tr>
    <td><input type="text" inputmode="numeric" value="${b.period}" data-i="${i}" data-k="period" style="width:56px"></td>
    <td><input type="time" value="${b.start}" data-i="${i}" data-k="start"></td>
    <td><input type="time" value="${b.end}" data-i="${i}" data-k="end"></td>
    <td><button type="button" class="chip" data-del="${i}">삭제</button></td></tr>`).join('');
}

$('#bells').addEventListener('input', (e) => {
  const { i, k } = e.target.dataset;
  if (i === undefined) return;
  bells[+i][k] = k === 'period' ? +e.target.value : e.target.value;
});
$('#bells').addEventListener('click', (e) => {
  if (e.target.dataset.del === undefined) return;
  bells.splice(+e.target.dataset.del, 1); drawBells();
});
$('#bell-add').onclick = () => {
  const lastB = bells[bells.length - 1];
  bells.push({ period: (lastB ? lastB.period : 0) + 1, start: '14:40', end: '15:20' });
  drawBells();
};
$('#bell-save').onclick = async () => {
  try {
    await api('/settings/bells', { method: 'PUT', body: JSON.stringify({ bells }) });
    toast('교시 시각을 저장했습니다');
    await loadBells(); loadTimetable();
  } catch (e) { if (!needLogin(e)) toast(e.message); }
};

async function loadBells() {
  const j = await api('/settings/bells');
  bells = j.bells;
  $('#bell-note').textContent = (j.default ? '(기본값 — 학교 시각으로 바꿔 저장하세요) ' : '') +
    `지금: ${j.now_period === 0 ? '아침' : j.now_period === 99 ? '방과후' : j.now_period + '교시'}`;
  drawBells();
}

async function loadTimetable() {
  const j = await api('/settings/timetable');
  const maxP = Math.max(6, ...bells.map((b) => b.period));
  const map = new Map(j.slots.map((s) => [`${s.weekday}-${s.period}`, s.subject]));
  let html = '';
  for (let p = 1; p <= maxP; p++) {
    html += `<tr><th>${p}</th>`;
    for (let w = 1; w <= 5; w++) html += `<td><input type="text" maxlength="30" data-w="${w}" data-p="${p}" value="${esc(map.get(`${w}-${p}`) || '')}"></td>`;
    html += '</tr>';
  }
  $('#tt').innerHTML = html;
}

$('#tt-save').onclick = async () => {
  const slots = [...document.querySelectorAll('#tt input')].map((i) => ({ weekday: +i.dataset.w, period: +i.dataset.p, subject: i.value }));
  try {
    await api('/settings/timetable', { method: 'PUT', body: JSON.stringify({ grade, class: cls, slots }) });
    toast('시간표를 저장했습니다');
  } catch (e) { if (!needLogin(e)) toast(e.message); }
};

// 빠르게 채우기: 1교시 시작·수업 길이·쉬는 시간·점심
const hm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
$('#qf-go').onclick = () => {
  const [h, m] = $('#qf-start').value.split(':').map(Number);
  const len = +$('#qf-len').value, brk = +$('#qf-brk').value, n = Math.min(9, Math.max(1, +$('#qf-n').value));
  const after = +$('#qf-lunch-after').value, lunch = +$('#qf-lunch').value;
  if (!(len > 0) || Number.isNaN(h)) { toast('값을 확인하세요'); return; }
  let t = h * 60 + m;
  bells = [];
  for (let p = 1; p <= n; p++) {
    if (t + len > 24 * 60 - 1) break;
    bells.push({ period: p, start: hm(t), end: hm(t + len) });
    t += len + (p === after ? lunch : brk);
  }
  drawBells();
  $('#qf').open = false;
  toast('채웠습니다. 확인한 뒤 저장을 누르세요');
};

// 지금 판과 최신 판(GitHub 의 package.json)
async function checkVersion() {
  const el = $('#ver');
  let cur = '';
  try { cur = (await (await fetch('/api/health', { cache: 'no-store' })).json()).version; } catch { /* 무시 */ }
  let latest = '';
  try { latest = (await (await fetch('https://raw.githubusercontent.com/pooha3240/classboard/main/package.json', { cache: 'no-store' })).json()).version; } catch { /* 무시 */ }
  const newer = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); return false; };
  el.innerHTML = `지금 판: <b>${esc(cur || '?')}</b>` + (latest ? ` · 최신 판: <b>${esc(latest)}</b> ${newer(latest, cur) ? '<span class="tag-new">업데이트 있음</span>' : '(최신)'}` : ' · 최신 판을 확인하지 못했습니다');
}
checkVersion();

// ── 나이스 시간표 자동 받기(선택) ──
let neisPick = null;
const fmtAt = (t) => new Date(t).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
async function loadNeis() {
  let j;
  try { j = await api('/settings/neis'); } catch (e) { $('#neis-status').textContent = e.message; return; }
  const st = $('#neis-status');
  if (!j.on) { st.innerHTML = '<span class="muted">꺼져 있음</span>'; $('#neis-key').placeholder = '나이스 교육정보 개방 포털 → 인증키 신청'; return; }
  const last = j.last ? (j.last.ok ? `마지막으로 받은 때 ${fmtAt(j.last.at)} (${j.last.rows}시간${j.last.changed ? ', 바뀐 것 반영' : ''})`
    : `<span class="warn">마지막 시도 ${fmtAt(j.last.at)} 실패: ${esc(j.last.error)}</span>`) : '아직 받지 않음';
  st.innerHTML = `<b>켜짐</b> · ${esc(j.school_name || j.school)} · 인증키 ${esc(j.key_hint)}<br><span class="muted">${last}${j.next ? ` · 다음 ${fmtAt(j.next)}` : ''}</span>
    <div class="row-end"><span></span><button type="button" class="chip" id="neis-off">끄기</button></div>`;
  $('#neis-key').placeholder = '바꿀 때만 넣으세요(비워 두면 지금 키 그대로)';
  $('#neis-q').value = j.school_name || '';
  neisPick = { office: j.office, school: j.school, name: j.school_name, kind: j.kind };
  $('#neis-picked').textContent = j.school_name ? `선택: ${j.school_name}` : '';
  $('#neis-save').disabled = false;
  $('#neis-off').onclick = async () => {
    if (!confirm('나이스 시간표 자동 받기를 끌까요? (이미 받은 시간표는 그대로 남습니다)')) return;
    try { await api('/settings/neis', { method: 'DELETE' }); toast('껐습니다'); $('#neis-key').value = ''; loadNeis(); } catch (e) { toast(e.message); }
  };
}
$('#neis-find').onclick = async () => {
  const q = $('#neis-q').value.trim();
  const box = $('#neis-schools');
  if (q.length < 2) { toast('학교 이름을 두 글자 이상 넣으세요'); return; }
  box.innerHTML = '<span class="muted small">찾는 중…</span>';
  try {
    const j = await api(`/settings/neis/schools?name=${encodeURIComponent(q)}&key=${encodeURIComponent($('#neis-key').value.trim())}`);
    if (!j.schools.length) { box.innerHTML = '<span class="muted small">찾지 못했습니다. 정식 이름(예: 언양초등학교)으로 다시 찾아 보세요</span>'; return; }
    box.innerHTML = j.schools.map((x, i) => `<button type="button" class="chip" data-i="${i}">${esc(x.name)} <span class="muted small">${esc(x.office_name)} · ${esc(x.address.split(' ').slice(0, 3).join(' '))}</span></button>`).join('');
    box.querySelectorAll('[data-i]').forEach((b) => { b.onclick = () => {
      const x = j.schools[+b.dataset.i];
      neisPick = { office: x.office, school: x.school, name: x.name, kind: x.kind };
      $('#neis-picked').textContent = `선택: ${x.name}`; box.innerHTML = ''; $('#neis-save').disabled = false;
    }; });
  } catch (e) { box.innerHTML = `<span class="warn small">${esc(e.message)}</span>`; }
};
$('#neis-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#neis-find').click(); } });
$('#neis-save').onclick = async () => {
  if (!neisPick) { toast('학교를 찾아서 고르세요'); return; }
  const b = $('#neis-save'); b.disabled = true; b.textContent = '확인하는 중…';
  try {
    const j = await api('/settings/neis', { method: 'PUT', body: JSON.stringify({ key: $('#neis-key').value.trim(), office: neisPick.office,
      school: neisPick.school, school_name: neisPick.name, kind: neisPick.kind }) });
    $('#neis-key').value = '';
    const s = j.sync;
    toast(Array.isArray(s) ? `저장했습니다. 나이스 시간표 ${s.reduce((n, r) => n + (r.rows || 0), 0)}시간을 받아 진도에 맞췄습니다`
      : `저장했습니다.${s && s.error ? ' ' + s.error : ''}`);
    loadNeis();
  } catch (e) { toast(e.message); } finally { b.disabled = false; b.textContent = '저장하고 지금 받기'; }
};
loadNeis();

(async () => {
  try {
    await loadBells();
    try {
      const me = await api('/me');
      grade = me.klass.grade; cls = me.klass.class;
      $('#tt-class').textContent = `${grade}학년 ${cls}반`;
    } catch { /* 학급 표시 없이 */ }
    await loadTimetable();
  } catch (e) { if (!needLogin(e)) toast(e.message); }
})();
