// 주간 진도·차시 자료: 나이스 파일 올리기, 주간 진도 조정(교체·없음·한 번 더·건너뛰기), 차시마다 자료 미리 올리기
import { api, getToken, needLogin, $, esc } from './auth.js';
import { MediaTools, YT_EMBED, uploadFile } from './media.js';
import { parsePlanXlsx, parseTtPdf } from './neis.js';

const qs = new URLSearchParams(location.search);
let grade = +qs.get('grade') || null, cls = +qs.get('class') || null;
let monday = null;            // 보고 있는 주 월요일 'YYYY-MM-DD'
let week = null;              // /plan/week 응답
let cur = null;               // 열어 둔 칸
let swapFrom = null;
const DAYS = ['월', '화', '수', '목', '금'];
const MB = 1024 * 1024;

function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), ms);
}
const fail = (e) => { if (!needLogin(e)) toast(e.message, 4000); };
const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n); return d.toLocaleDateString('sv-SE'); };
const md = (iso) => `${+iso.slice(5, 7)}/${+iso.slice(8, 10)}`;
const q = () => `grade=${grade}&class=${cls}`;

// ── 주간 표 ──
async function load(date) {
  try {
    week = await api(`/plan/week?${q()}${date ? `&date=${date}` : ''}`);
  } catch (e) { fail(e); return; }
  monday = week.monday;
  $('#pl-range').textContent = `${md(monday)} ~ ${md(addDays(monday, 4))}`;
  history.replaceState(null, '', `?${q()}&date=${monday}`);
  render();
}

function render() {
  const g = $('#pl-grid');
  $('#pl-neis').hidden = !week.neis;
  if (week.term) $('#pl-neis-st').textContent = week.term.tt_source === 'api' ? `나이스 시간표 사용 중 · 마지막으로 받은 때 ${week.term.synced}` : week.term.tt_source === 'pdf' ? '시간표 PDF 사용 중' : '시간표 없음(진도표 순서로 교시)';
  if (!week.term) {
    $('#pl-upload').hidden = false;
    g.innerHTML = `<div class="empty muted">이 주의 진도표가 없습니다.${week.nearest ? ` <button type="button" class="chip" data-go="${week.nearest}">진도표가 있는 주로 (${md(week.nearest)})</button>` : ' 위에서 나이스 파일을 올려 주세요.'}</div>`;
    $('#pl-extra').innerHTML = '';
    return;
  }
  const byKey = new Map(week.slots.map((s) => [`${s.date}|${s.period}`, s]));
  const maxP = Math.max(6, ...week.slots.map((s) => s.period));
  let html = '<table class="pl-table"><thead><tr><th></th>';
  for (let i = 0; i < 5; i++) {
    const d = addDays(monday, i);
    html += `<th class="${d === week.today ? 'today' : ''}">${DAYS[i]} <span class="muted">${md(d)}</span></th>`;
  }
  html += '</tr></thead><tbody>';
  for (let p = 1; p <= maxP; p++) {
    html += `<tr><th>${p}</th>`;
    for (let i = 0; i < 5; i++) {
      const s = byKey.get(`${addDays(monday, i)}|${p}`);
      if (!s) { html += '<td class="none"></td>'; continue; }
      const le = s.lesson;
      const cls2 = ['slot', s.cancelled ? 'off' : '', s.subject !== s.orig ? 'moved' : '', swapFrom && swapFrom.id === s.id ? 'swapping' : '',
        le && le.repeat ? 'again' : ''].join(' ');
      html += `<td><button type="button" class="${cls2}" data-slot="${s.id}">
        <b>${esc(s.short)}</b>${le && le.no ? `<span class="no">${le.no}/${le.total}</span>` : ''}${le && le.media ? `<span class="clip" title="차시 자료">📎${le.media}</span>` : ''}
        ${s.cancelled ? `<span class="topic">없음${s.note ? ` · ${esc(s.note)}` : ''}</span>` : le && le.topic ? `<span class="topic">${esc(le.topic)}</span>` : ''}
        ${s.subject !== s.orig ? `<span class="tag">원래 ${esc(s.orig)}</span>` : ''}${le && le.repeat ? '<span class="tag">한 번 더</span>' : ''}
      </button></td>`;
    }
    html += '</tr>';
  }
  html += '</tbody></table>';
  g.innerHTML = html;
  const ex = [];
  if (week.left.length) ex.push(`<div class="panel"><h3>학기 안에 못 하는 차시</h3><p class="muted small">시간을 빼거나 '한 번 더'를 넣어서 학기 끝까지 밀린 차시입니다.</p>
    <ul>${week.left.map((l) => `<li><b>${esc(l.subject)}</b> ${l.count}개 <span class="muted">(${esc(l.first)}부터)</span></li>`).join('')}</ul></div>`);
  if (week.skipped.length) ex.push(`<div class="panel"><h3>건너뛴 차시</h3><ul>${week.skipped.map((l) => `<li><b>${esc(l.subject)}</b> ${esc(l.label)}
    <button type="button" class="chip" data-unskip="${l.id}">되살리기</button></li>`).join('')}</ul></div>`);
  $('#pl-extra').innerHTML = ex.join('');
}

$('#pl-grid').addEventListener('click', (e) => {
  const go = e.target.closest('[data-go]');
  if (go) { load(go.dataset.go); return; }
  const b = e.target.closest('[data-slot]');
  if (!b) return;
  const s = week.slots.find((x) => x.id === +b.dataset.slot);
  if (swapFrom) { doSwap(s); return; }
  openSlot(s);
});
$('#pl-extra').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-unskip]');
  if (!b) return;
  try { await api(`/plan/lesson/${b.dataset.unskip}`, { method: 'POST', body: JSON.stringify({ action: 'unskip' }) }); load(monday); } catch (er) { fail(er); }
});
$('#pl-prev').onclick = () => load(addDays(monday, -7));
$('#pl-next').onclick = () => load(addDays(monday, 7));
$('#pl-today').onclick = () => load();

// ── 교체 ──
async function doSwap(s) {
  const a = swapFrom;
  swapFrom = null; $('#pl-swap').hidden = true;
  if (!s || s.id === a.id) { render(); return; }
  try {
    await api('/plan/swap', { method: 'POST', body: JSON.stringify({ a: a.id, b: s.id }) });
    toast(`${md(a.date)} ${a.period}교시와 ${md(s.date)} ${s.period}교시를 바꿨습니다`);
    load(monday);
  } catch (e) { fail(e); render(); }
}
$('#pl-swap-cancel').onclick = () => { swapFrom = null; $('#pl-swap').hidden = true; render(); };

// ── 칸 자세히 ──
const dlg = $('#pl-dlg');
$('#pd-close').onclick = () => dlg.close();

function openSlot(s) {
  cur = s;
  const wd = DAYS[(new Date(s.date + 'T00:00:00').getDay() + 6) % 7];
  $('#pd-title').textContent = `${md(s.date)}(${wd}) ${s.period}교시 · ${s.subject}${s.cancelled ? ' (없음)' : ''}`;
  const le = s.lesson;
  $('#pd-lesson').innerHTML = s.cancelled ? `<p>이 시간은 없음으로 해 두었습니다${s.note ? `: <b>${esc(s.note)}</b>` : ''}. 이 과목의 뒤 차시는 다음 시간으로 밀렸습니다.</p>`
    : le && (le.unit || le.topic) ? `<p class="pd-unit">${esc(le.unit)}${le.no ? ` · <b>${le.no}/${le.total}차시</b>` : ''}${le.pages ? ` · ${esc(le.pages)}쪽` : ''}</p><p class="pd-topic">${esc(le.topic)}</p>${le.note ? `<p class="muted small">${esc(le.note)}</p>` : ''}`
      : '<p class="muted">진도표에 차시 내용이 없는 시간입니다(창체 등). 자료는 붙일 수 있습니다.</p>';
  const subjOpts = week.subjects.map((x) => `<option ${x === s.subject ? 'selected' : ''}>${esc(x)}</option>`).join('');
  $('#pd-acts').innerHTML = `
    <button type="button" class="chip" data-a="swap">다른 시간과 바꾸기</button>
    <span class="pd-subj"><select id="pd-subj" class="chip">${subjOpts}</select><button type="button" class="chip" data-a="subject">과목 바꾸기</button></span>
    ${s.cancelled ? '<button type="button" class="chip" data-a="restore">되살리기</button>'
      : '<span class="pd-subj"><input type="text" id="pd-note" maxlength="60" placeholder="대신 하는 일(예: 현장체험학습)"><button type="button" class="chip" data-a="cancel">이 시간 없음</button></span>'}
    ${le && !le.ph && !s.cancelled ? `<button type="button" class="chip" data-a="repeat" title="이 차시를 다음 시간에 한 번 더 합니다(뒤 차시가 한 칸씩 밀림)">이 차시 한 번 더</button>
      ${le.repeat ? '<button type="button" class="chip" data-a="remove">한 번 더 지우기</button>' : '<button type="button" class="chip" data-a="skip" title="이 차시를 빼고 뒤 차시를 당깁니다">이 차시 건너뛰기</button>'}` : ''}`;
  $('#pd-add').hidden = !le || s.cancelled;
  $('#pd-recent').hidden = true;
  $('#pd-progress').textContent = '';
  loadMedia();
  if (!dlg.open) dlg.showModal();
}

$('#pd-acts').addEventListener('click', async (e) => {
  const a = e.target.closest('[data-a]')?.dataset.a;
  if (!a || !cur) return;
  const s = cur;
  try {
    if (a === 'swap') {
      swapFrom = s; dlg.close(); $('#pl-swap').hidden = false; render(); return;
    }
    if (a === 'subject') await api(`/plan/slot/${s.id}`, { method: 'POST', body: JSON.stringify({ action: 'subject', subject: $('#pd-subj').value }) });
    else if (a === 'cancel') await api(`/plan/slot/${s.id}`, { method: 'POST', body: JSON.stringify({ action: 'cancel', note: $('#pd-note').value }) });
    else if (a === 'restore') await api(`/plan/slot/${s.id}`, { method: 'POST', body: JSON.stringify({ action: 'restore' }) });
    else await api(`/plan/lesson/${s.lesson.id}`, { method: 'POST', body: JSON.stringify({ action: a }) });
    toast({ subject: '과목을 바꿨습니다', cancel: '이 시간을 없음으로 했습니다. 뒤 차시가 밀렸습니다', restore: '되살렸습니다', repeat: '다음 시간에 이 차시를 한 번 더 합니다', skip: '건너뛰었습니다. 뒤 차시를 당겼습니다', remove: '한 번 더를 지웠습니다' }[a]);
    dlg.close();
    load(monday);
  } catch (er) { fail(er); }
});

// ── 차시 자료 ──
async function loadMedia() {
  const box = $('#pd-media');
  const le = cur && !cur.cancelled && cur.lesson;
  if (!le) { box.innerHTML = ''; return; }
  try {
    const j = await api(`/plan/media?${q()}&lkey=${le.lkey}`);
    box.innerHTML = j.items.length ? j.items.map((m, i) => `<div class="pd-item">
      ${m.thumb ? `<img src="${m.thumb}" alt="">` : `<span class="pd-ico">${m.kind === 'yt' ? '▶' : m.kind === 'web' ? '🌐' : '📄'}</span>`}
      <span class="pd-name">${esc(m.title || (m.kind === 'yt' ? `유튜브 ${m.yt}` : m.kind === 'web' ? m.url : m.kind === 'video' ? '동영상' : '자료'))}
        <span class="muted small">${m.kind === 'pages' ? `${m.count}쪽` : m.kind === 'video' ? '동영상' : m.kind === 'yt' ? '유튜브' : '웹페이지'}</span></span>
      <button type="button" class="chip" data-mv="${m.id}" data-dir="-1" ${i === 0 ? 'disabled' : ''} aria-label="위로">↑</button>
      <button type="button" class="chip" data-mv="${m.id}" data-dir="1" ${i === j.items.length - 1 ? 'disabled' : ''} aria-label="아래로">↓</button>
      <button type="button" class="chip" data-del="${m.id}">빼기</button></div>`).join('')
      : '<p class="muted small">아직 붙인 자료가 없습니다.</p>';
  } catch (e) { fail(e); }
}

$('#pd-media').addEventListener('click', async (e) => {
  const mv = e.target.closest('[data-mv]'), del = e.target.closest('[data-del]');
  try {
    if (mv) await api(`/plan/media/${mv.dataset.mv}/move`, { method: 'POST', body: JSON.stringify({ dir: +mv.dataset.dir }) });
    else if (del) await api(`/plan/media/${del.dataset.del}`, { method: 'DELETE' });
    else return;
    await loadMedia(); refreshCount();
  } catch (er) { fail(er); }
});

async function attach(body) {
  await api('/plan/media', { method: 'POST', body: JSON.stringify({ grade, class: cls, lkey: cur.lesson.lkey, ...body }) });
  await loadMedia(); refreshCount();
}

function refreshCount() { load(monday).then(() => { if (cur) cur = week.slots.find((x) => x.id === cur.id) || cur; }); }

$('#pd-upload').onclick = () => $('#pd-file').click();
$('#pd-file').onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (f) await uploadFor(f);
};
dlg.addEventListener('dragover', (e) => { if (cur && cur.lesson) e.preventDefault(); });
dlg.addEventListener('drop', (e) => {
  if (!cur || !cur.lesson) return;
  e.preventDefault();
  const f = e.dataTransfer.files[0];
  if (f) uploadFor(f);
});

async function uploadFor(file) {
  const prog = $('#pd-progress');
  try {
    const res = await uploadFile(file, { token: await getToken(), onProgress: (p, t) => { prog.textContent = t; } });
    await attachResult(res);
    prog.textContent = '';
    toast(`${file.name} 을(를) 이 차시에 붙였습니다`);
  } catch (e) { prog.textContent = ''; fail(e); }
}

async function attachResult(res) {
  await attach({ kind: 'pages', assets: res.items.map((it) => it.asset).slice(0, 60), title: res.name || '' });
}

$('#pd-url-add').onclick = async () => {
  const url = MediaTools.normalizeUrl($('#pd-url').value);
  if (!url) { toast('주소를 확인하세요'); return; }
  const yt = url.match(YT_EMBED);
  try {
    await attach(yt ? { kind: 'yt', yt: yt[1], start: +(yt[2] || 0) } : { kind: 'web', url });
    $('#pd-url').value = '';
  } catch (e) { fail(e); }
};

$('#pd-recent-btn').onclick = async () => {
  const box = $('#pd-recent');
  if (!box.hidden) { box.hidden = true; return; }
  try {
    const j = await api('/media/recent');
    box.innerHTML = j.files.length ? j.files.map((f) => `<button type="button" class="md-file ${f.kind === 'video' ? 'video' : ''}" data-asset="${f.asset}">
      <img src="${f.thumb}" alt="" loading="lazy"><span>${esc(f.name || '')}</span></button>`).join('') : '<p class="muted small">올린 자료가 없습니다</p>';
    box.hidden = false;
  } catch (e) { fail(e); }
};
$('#pd-recent').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-asset]');
  if (!b) return;
  try {
    const set = await api(`/media/${b.dataset.asset}/set`);
    await attachResult(set);
    $('#pd-recent').hidden = true;
    toast('이 차시에 붙였습니다');
  } catch (er) { fail(er); }
});

// ── 나이스 시간표 지금 받아오기 ──
$('#pl-neis-btn').onclick = async () => {
  const b = $('#pl-neis-btn'); b.disabled = true;
  try {
    const j = await api(`/plan/neis?${q()}`, { method: 'POST' });
    const ch = j.results.filter((r) => r.changed);
    toast(ch.length ? `나이스 시간표가 바뀐 것을 반영했습니다(${ch.map((r) => r.term).join(', ')})` : '나이스 시간표와 같습니다. 바뀐 것이 없습니다', 4000);
    load(monday);
  } catch (e) { fail(e); } finally { b.disabled = false; }
};

// ── 나이스 파일 올리기 ──
$('#pl-upload-toggle').onclick = () => { $('#pl-upload').hidden = !$('#pl-upload').hidden; if (!$('#pl-upload').hidden) loadTerms(); };
$('#pl-pick').onclick = () => $('#pl-file').click();
$('#pl-file').onchange = (e) => { const fs = [...e.target.files]; e.target.value = ''; uploadNeis(fs); };
const drop = $('#pl-drop');
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); uploadNeis([...e.dataTransfer.files]); });

async function uploadNeis(files, force = false) {
  // 엑셀(진도)을 먼저, 시간표 PDF 를 나중에 → 마지막에 둘을 맞춤
  files.sort((a, b) => (/\.pdf$/i.test(a.name) ? 1 : 0) - (/\.pdf$/i.test(b.name) ? 1 : 0));
  const out = $('#pl-result');
  for (const f of files) {
    out.insertAdjacentHTML('beforeend', `<p class="muted">${esc(f.name)} 읽는 중…</p>`);
    const line = out.lastElementChild;
    try {
      const token = await getToken();
      const buf = await f.arrayBuffer();
      const head = new Uint8Array(buf.slice(0, 4));
      let kind, parsed;
      if (head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46) {          // %PDF: 학기별 시간표
        const lib = await import('/vendor/pdfjs/pdf.min.mjs');
        lib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
        kind = 'timetable'; parsed = await parseTtPdf(buf, lib);
      } else if (head[0] === 0x50 && head[1] === 0x4b) {                                           // PK: 엑셀(.xlsx)
        kind = 'plan'; parsed = await parsePlanXlsx(buf);
      } else throw new Error('나이스에서 내려받은 연간지도계획(.xlsx) 또는 학기별 시간표(PDF)를 올려 주세요');
      line.textContent = `${f.name} 맞추는 중…`;
      const r = await fetch(`/eboard-api/plan/upload?kind=${kind}&name=${encodeURIComponent(f.name)}${force ? '&force=1' : ''}`, {
        method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(parsed) });
      const j = await r.json().catch(() => ({}));
      if (r.status === 409 && j.detail && j.detail.error === 'class_mismatch') {
        line.innerHTML = `<b>${esc(f.name)}</b>: ${esc(j.detail.message)}. 지금 고른 반은 ${grade}학년 ${cls}반입니다. <button type="button" class="chip" data-force>그래도 이 반에 올리기</button>`;
        line.querySelector('[data-force]').onclick = () => { line.remove(); uploadNeis([f], true); };
        continue;
      }
      if (!r.ok) throw new Error((j.detail && j.detail.message) || `올리지 못했습니다(${r.status})`);
      line.className = '';
      line.innerHTML = j.kind === 'plan'
        ? `✔ <b>진도표</b> ${esc(j.term.replace('-', '학년도 '))}학기 · ${md(j.first)}~${md(j.last)} · ${j.hours}시간${j.neis && j.neis.rows ? ' · 나이스 시간표 받음' : ''}${j.neis && j.neis.error ? ` · <span class="warn">${esc(j.neis.error)}</span>` : ''}${j.with_tt ? ` · 시간표와 맞춤(창체 등 진도표에 없는 시간 ${j.free}개${j.unplaced ? `, 시간표에 자리가 없는 차시 ${j.unplaced}개` : ''})` : ' · <span class="warn">시간표 PDF 도 올리면 교시가 더 정확해집니다</span>'}${j.edits ? ` · 조정 ${j.edits}개 다시 적용` : ''}${j.edits_dropped ? `(${j.edits_dropped}개는 시간표가 바뀌어 건너뜀)` : ''}`
        : `✔ <b>시간표</b> ${md(j.first)}~${md(j.last)} · ${j.days}일 ${j.hours}시간(휴업일 ${j.holidays}일 제외)${j.rebuilt.length ? ` · 진도표와 맞춤: ${j.rebuilt.map((x) => `${esc(x.term)} ${x.matched}/${x.hours}차시 자리 찾음`).join(', ')}` : ' · 이 기간 진도표(엑셀)를 올리면 차시가 붙습니다'}`;
    } catch (e) { line.className = 'warn'; line.textContent = `${f.name}: ${e.message}`; if (needLogin(e)) return; }
  }
  loadTerms();
  load(monday);
}

async function loadTerms() {
  try {
    const j = await api(`/plan/terms?${q()}`);
    $('#pl-terms').innerHTML = j.terms.length ? '올린 진도표: ' + j.terms.map((t) => `${esc(t.term.replace('-', '학년도 '))}학기(${md(t.first)}~${md(t.last)}, ${t.hours}시간, ${esc(t.uploaded_at.slice(0, 16))})`).join(' · ') : '아직 올린 진도표가 없습니다.';
  } catch (e) { fail(e); }
}

// ── 시작 ──
(async () => {
  try {
    const me = await api('/me');
    grade = me.klass.grade; cls = me.klass.class;
    $('#pl-class').textContent = `${grade}학년 ${cls}반`;
  } catch (e) { if (needLogin(e)) return; }
  await load(qs.get('date') || '');
})();
