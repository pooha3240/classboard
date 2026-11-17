// 교시 시각·학급 시간표 설정
import { api, needLogin, $, esc, getToken } from './auth.js';

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
  let cur = '', edition = 'basic';
  try { const h = await (await fetch('/api/health', { cache: 'no-store' })).json(); cur = h.version; edition = h.edition || 'basic'; } catch { /* 무시 */ }
  loadStore(edition);
  let latest = '';
  try { latest = (await (await fetch('https://raw.githubusercontent.com/pooha3240/classboard/main/package.json', { cache: 'no-store' })).json()).version; } catch { /* 무시 */ }
  const newer = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); return false; };
  el.innerHTML = `${edition === 'storage' ? '확장판' : '기본판'} · 지금 판: <b>${esc(cur || '?')}</b>` + (latest ? ` · 최신 판: <b>${esc(latest)}</b> ${newer(latest, cur) ? '<span class="tag-new">업데이트 있음</span>' : '(최신)'}` : ' · 최신 판을 확인하지 못했습니다');
}
checkVersion();

// ── 확장판: 저장 공간·백업·되살리기 ──
const mb = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}GB` : n >= 1e6 ? `${Math.round(n / 1e6)}MB` : `${Math.max(1, Math.round(n / 1e3))}KB`);
let edition = 'basic';
async function loadStore(ed = edition) {
  edition = ed;
  try {
    const j = await api('/history/sessions?start=9999-01-01');
    const s = j.storage, r2 = s.r2;
    $('#store-usage').innerHTML = r2
      ? `칠판 저장소 ${mb(s.db)} / ${mb(s.budget)} · R2 ${mb(r2.media + r2.archive)} / ${mb(r2.cap)}
        <span class="muted">(자료 ${mb(r2.media)}, 보관한 판서 기록 ${mb(r2.archive)})</span>
        <br><span class="muted">R2 는 무료 10GB 를 넘지 않도록 8GB 에서 막습니다. 60일이 지난 판서 기록은 재생 기록까지 R2 로 옮겨 보관합니다.</span>`
      : `칠판 저장소 ${mb(s.db)} / ${mb(s.budget)} <span class="muted">(자료 ${mb(s.media)} 포함)</span>
        <br><span class="muted">기본판은 판서 기록과 자료를 합쳐 950MB 까지 씁니다. 판서 재생 기록은 60일까지 남습니다. 오래 보관하려면 백업을 내려받아 두세요.</span>`;
  } catch (e) { $('#store-usage').textContent = e.message; }
}

// 백업: 크롬·엣지는 저장 위치를 먼저 고르고 받는 대로 바로 파일에 씀(크기 제한 없음).
// 그 밖의 브라우저는 메모리에 모았다가 한 번에 저장(자료를 넣은 큰 백업은 실패할 수 있음).
$('#bk-go').onclick = async () => {
  const b = $('#bk-go'), st = $('#bk-st');
  const media = $('#bk-media').checked ? 1 : 0;
  const day = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' }).replaceAll('-', '');
  const name = `classboard-backup-${day}.ndjson.gz`;
  let sink = null;                                    // { write(text), close() }
  if ('showSaveFilePicker' in window) {
    let handle;
    try {
      handle = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: 'classboard 백업', accept: { 'application/gzip': ['.gz'] } }] });
    } catch (e) { if (e && e.name === 'AbortError') return; handle = null; }
    if (handle) {
      const file = await handle.createWritable();
      const ts = new TransformStream();
      const done = ts.readable.pipeThrough(new TextEncoderStream()).pipeThrough(new CompressionStream('gzip')).pipeTo(file);
      const w = ts.writable.getWriter();
      sink = { write: (t) => w.write(t), close: async () => { await w.close(); await done; }, abort: async () => { try { await w.abort(); } catch { /* 무시 */ } } };
    }
  }
  if (!sink && media && !confirm('이 브라우저는 큰 백업을 바로 파일에 쓰지 못해 메모리에 모았다가 저장합니다. 자료가 많으면 실패할 수 있습니다(크롬·엣지 권장). 계속할까요?')) return;
  const parts = [];
  if (!sink) sink = { write: (t) => { parts.push(t); }, close: async () => {
    const gz = await new Response(new Blob(parts).stream().pipeThrough(new CompressionStream('gzip'))).blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(gz); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  }, abort: async () => {} };
  b.disabled = true;
  let size = 0;
  try {
    const token = await getToken();
    let cursor = null, n = 0;
    do {
      const r = await fetch(`/eboard-api/backup/part?media=${media}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { headers: { Authorization: 'Bearer ' + token } });
      const j = await r.json();
      if (!r.ok) throw new Error((j.detail && j.detail.message) || `백업 실패 (${r.status})`);
      for (const ln of j.lines) { const t = JSON.stringify(ln) + '\n'; await sink.write(t); size += t.length; n++; }
      st.textContent = `받는 중… ${n}줄 · ${mb(size)}`;
      cursor = j.next;
    } while (cursor);
    st.textContent = '마무리하는 중…';
    await sink.close();
    st.textContent = `백업을 저장했습니다 (압축 전 ${mb(size)}).`;
  } catch (e) { await sink.abort(); st.textContent = e.message; } finally { b.disabled = false; }
};

$('#rs-go').onclick = async () => {
  const f = $('#rs-file').files[0], st = $('#rs-st'), pw = $('#rs-pw').value;
  if (!f) { toast('백업 파일을 고르세요'); return; }
  if (!pw) { toast('교사 비밀번호를 넣으세요'); return; }
  if (!confirm('지금 칠판의 판서 기록·진도표·자료가 모두 지워지고 백업 내용으로 바뀝니다. 계속할까요?')) return;
  const b = $('#rs-go'); b.disabled = true;
  try {
    const token = await getToken();
    const post = async (path, body) => {
      const r = await fetch('/eboard-api/backup/restore/' + path, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error((j.detail && j.detail.message) || `되살리기 실패 (${r.status})`);
      return j;
    };
    let stream = f.stream();
    const head = new Uint8Array(await f.slice(0, 2).arrayBuffer());
    if (head[0] === 0x1f && head[1] === 0x8b) stream = stream.pipeThrough(new DecompressionStream('gzip'));
    const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
    let buf = '', batch = [], batchSize = 0, started = false, total = 0, blobs = 0, skipped = 0;
    const flush = async () => {
      if (!batch.length) return;
      const r = await post('rows', { lines: batch });
      total += r.rows; blobs += r.blobs; skipped += r.skipped; batch = []; batchSize = 0;
      st.textContent = `되살리는 중… ${total}줄${blobs ? ` · 자료 ${blobs}장` : ''}`;
    };
    const take = async (line) => {
      if (!line.trim()) return;
      const o = JSON.parse(line);
      if (!started) {
        if (o.t !== 'meta') throw new Error('classboard 백업 파일이 아닙니다');
        await post('begin', { password: pw, meta: o });
        started = true; return;
      }
      batch.push(o); batchSize += line.length;
      if (batchSize > 3_000_000 || batch.length >= 3000) await flush();
    };
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { await take(buf.slice(0, i)); buf = buf.slice(i + 1); }
    }
    await take(buf); await flush();
    if (!started) throw new Error('빈 파일입니다');
    await post('end', {});
    st.textContent = `되살렸습니다 (${total}줄${blobs ? `, 자료 ${blobs}장` : ''}).${skipped ? ` 자료 ${skipped}개는 공간이 모자라거나 읽을 수 없어 건너뛰었습니다.` : ''} 칠판을 새로 고치세요.`;
    $('#rs-pw').value = '';
    loadBells(); loadTimetable(); loadStore();
  } catch (e) { st.textContent = e.message; } finally { b.disabled = false; }
};

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

// 전자칠판 도우미(크롬 확장)가 깔렸는지
setTimeout(() => {
  const v = document.documentElement.getAttribute('data-ebx-helper');
  const el = document.getElementById('helper-st');
  if (el) el.textContent = v ? `· 깔림 (${v})` : '· 이 브라우저에는 아직 없음';
}, 300);
