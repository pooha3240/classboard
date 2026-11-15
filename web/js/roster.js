// 학급 명단 관리: 자리별 사용 계정, 상태(사용·확인 필요·전출), 계정 제외
import { api, needLogin, $, esc } from './auth.js';

const qs = new URLSearchParams(location.search);
let grade = +qs.get('grade') || null, cls = +qs.get('class') || null;
const STATUS = { active: '사용', pending: '확인 필요', left: '전출·제외' };

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 2400);
}

async function load() {
  let j;
  try { j = await api(`/roster?grade=${grade}&class=${cls}`); } catch (e) { if (!needLogin(e)) toast(e.message); return; }
  const seats = j.seats;
  const n = (st) => seats.filter((s) => s.status === st).length;
  $('#summary').textContent = `사용 ${n('active')}명 · 확인 필요 ${n('pending')}명 · 전출 ${n('left')}명`;
  if (!seats.length) { $('#rows').innerHTML = '<tr><td colspan="5" class="muted">학생 계정이 없습니다</td></tr>'; return; }
  if (seats[0].candidates === undefined) { needLogin({ code: 'pin_required' }); return; }
  $('#rows').innerHTML = seats.map((s) => `<tr data-seat="${s.seat}" class="${s.status}">
    <td>${s.seat}</td>
    <td>${esc(s.name)}${s.missing ? ' <span class="muted small">(계정 없음)</span>' : ''}</td>
    <td><select data-act="status">${Object.entries(STATUS).map(([k, l]) => `<option value="${k}" ${k === s.status ? 'selected' : ''}>${l}</option>`).join('')}</select></td>
    <td><select data-act="account">${s.candidates.map((c) => `<option value="${esc(c.mb_id)}" ${c.mb_id === s.mb_id ? 'selected' : ''}>${esc(c.mb_id)} (${esc(c.name)}${c.last_login ? ' · ' + esc(c.last_login.slice(5)) : ''})</option>`).join('')}</select></td>
    <td>${s.candidates.filter((c) => c.mb_id !== s.mb_id).map((c) => `<button type="button" class="chip" data-ignore="${esc(c.mb_id)}" title="이 계정을 명단에서 제외">${esc(c.mb_id)} 제외</button>`).join(' ') || '<span class="muted small">없음</span>'}</td>
  </tr>`).join('');
}

$('#rows').addEventListener('change', async (e) => {
  const tr = e.target.closest('tr'); const act = e.target.dataset.act;
  if (!tr || !act) return;
  const body = { grade, class: cls, ...(act === 'status' ? { status: e.target.value } : { mb_id: e.target.value }) };
  try { await api(`/roster/${tr.dataset.seat}`, { method: 'PATCH', body: JSON.stringify(body) }); toast('바꿨습니다'); load(); } catch (err) { toast(err.message); }
});
$('#rows').addEventListener('click', async (e) => {
  const id = e.target.dataset.ignore; if (!id) return;
  if (!confirm(`${id} 계정을 명단에서 제외할까요? (그누보드 계정은 그대로 둡니다)`)) return;
  try { await api('/roster/ignore', { method: 'POST', body: JSON.stringify({ mb_id: id, reason: '중복' }) }); toast('제외했습니다'); load(); } catch (err) { toast(err.message); }
});

(async () => {
  try {
    const c = await api('/classes');
    const sel = $('#class-select');
    sel.innerHTML = c.classes.map((x) => `<option value="${x.grade}-${x.class}">${x.grade}학년 ${x.class}반</option>`).join('');
    if (!grade && c.classes.length) { grade = c.classes[0].grade; cls = c.classes[0].class; }
    if (grade && !c.classes.some((x) => x.grade === grade && x.class === cls)) {
      sel.insertAdjacentHTML('afterbegin', `<option value="${grade}-${cls}">${grade}학년 ${cls}반</option>`);
    }
    sel.value = `${grade}-${cls}`;
    sel.onchange = () => { [grade, cls] = sel.value.split('-').map(Number); load(); };
  } catch (e) { if (needLogin(e)) return; }
  load();
})();
