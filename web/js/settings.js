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
