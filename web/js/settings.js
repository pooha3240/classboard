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
    loadBells();
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
  const j = await api(`/settings/timetable?grade=${grade}&class=${cls}`);
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

(async () => {
  try {
    await loadBells();
    try {
      const c = await api('/classes');
      const sel = $('#tt-class');
      sel.innerHTML = c.classes.map((x) => `<option value="${x.grade}-${x.class}">${x.grade}학년 ${x.class}반</option>`).join('');
      if (!grade && c.classes.length) { grade = c.classes[0].grade; cls = c.classes[0].class; }
    if (grade && !c.classes.some((x) => x.grade === grade && x.class === cls)) {
      sel.insertAdjacentHTML('afterbegin', `<option value="${grade}-${cls}">${grade}학년 ${cls}반</option>`);
    }
      sel.value = `${grade}-${cls}`;
      sel.onchange = () => { [grade, cls] = sel.value.split('-').map(Number); loadTimetable(); $('#plan-link').href = `plan.php?grade=${grade}&class=${cls}`; };
      $('#plan-link').href = `plan.php?grade=${grade}&class=${cls}`;
    } catch { $('#tt-class').innerHTML = `<option>${grade}학년 ${cls}반</option>`; }
    await loadTimetable();
  } catch (e) { if (!needLogin(e)) toast(e.message); }
})();
