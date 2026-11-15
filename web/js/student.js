// 학생 화면: 선생님이 부를 때만 사진 보내기 / 칠판에 풀기
import { Board } from './model.js';
import { Renderer } from './render.js';
import { Net } from './net.js';
import { Tools } from './tools.js';
import { Receiver } from './rtc.js';
import { VideoBg } from './video.js';

const $ = (s, el = document) => el.querySelector(s);
const STU_COLORS = ['#1d1d1b', '#ffffff', '#d62839', '#1b5fd1', '#1e8a4c'];

let net = null, board = null, renderer = null, tools = null;
let grant = null;               // 지금 진행 중인 호출
let rx = null;                  // 선생님 음성·영상(원격 참여)
let vbg = null;                 // 동영상 배경(선생님이 조작, 집에서 보는 학생만 소리)
const mine = new Set();         // 내가 그린 객체(지우기·고치기 가능)

function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), ms);
}

function setStatus(state, text) { $('#conn').dataset.state = state; $('#conn-text').textContent = text; }

function show(id) {
  for (const s of ['wait', 'invite', 'photo', 'solve']) $('#' + s).hidden = s !== id;
  $('#mode-label').textContent = id === 'photo' ? '사진 보내기' : id === 'solve' ? (grant && grant.home ? (grant.mode === 'solve' ? '원격 참여 · 칠판에 쓰기' : '원격 참여') : '칠판에 풀기') : '';
  if (id === 'solve' && renderer) requestAnimationFrame(() => renderer.resize());
}

function buzz() { try { navigator.vibrate && navigator.vibrate([120, 60, 120]); } catch { /* 무시 */ } }

// ── 호출 받기 ──
function onInvite(g) {
  grant = g;
  const T = {
    solve: ['선생님이 칠판에 풀어 보래요', '시작하면 지금 칠판이 보이고, 내가 쓰는 것이 칠판에 바로 나옵니다.'],
    photo: ['선생님이 사진을 보내 달래요', '공책이나 활동지를 사진으로 찍어 보내면 선생님이 보고 칠판에 띄웁니다.'],
    watch: ['선생님이 원격 수업에 불렀어요', '집에서 칠판과 선생님 목소리·영상을 볼 수 있어요. 질문이 있으면 손을 드세요.'],
  }[g.mode] || ['선생님이 불렀어요', ''];
  $('#invite-title').textContent = T[0];
  $('#invite-desc').textContent = T[1];
  show('invite');
  buzz();
}

async function accept() {
  if (!grant) return;
  const r = await net.call('call:accept', { id: grant.id }).catch(() => null);
  if (!r || !r.ok) { toast('시작하지 못했습니다. 선생님이 호출을 끝냈을 수 있어요'); show('wait'); grant = null; return; }
  grant = r.grant;
  if (grant.mode === 'photo') { resetPhoto(); show('photo'); return; }
  startSolve(r);
}

async function decline() {
  if (grant) await net.call('call:decline', { id: grant.id }).catch(() => null);
  grant = null; show('wait');
}

function onEnded(d) {
  if (!grant || d.id !== grant.id) return;
  grant = null;
  if (tools) { tools.selection.clear(); tools.readOnly = false; }
  if (rx) rx.close();
  if (vbg) vbg.onPage(null);
  document.body.classList.remove('stu-watch');
  const msg = d.reason === 'approved' ? '선생님이 사진을 받았습니다. 고마워요!' : d.status === 'expired' ? '시간이 지나 호출이 끝났습니다' : '선생님이 호출을 끝냈습니다';
  toast(msg, 3500);
  show('wait');
}

// ── 사진 ──
let photoFile = null;
function resetPhoto() {
  photoFile = null;
  $('#photo-preview').hidden = true; $('#photo-send').hidden = true;
  $('#photo-msg').textContent = '공책이나 활동지를 찍어서 보내세요. 선생님이 보고 칠판에 띄웁니다.';
}

function pickPhoto(f) {
  if (!f) return;
  photoFile = f;
  const img = $('#photo-preview img');
  if (img.src.startsWith('blob:')) URL.revokeObjectURL(img.src);
  img.src = URL.createObjectURL(f);
  $('#photo-preview').hidden = false; $('#photo-send').hidden = false;
  $('#photo-msg').textContent = '이 사진을 보낼까요? 흐리면 다시 찍으세요.';
}

async function sendPhoto() {
  if (!photoFile || !grant) return;
  const bar = $('#photo-progress');
  bar.hidden = false; $('#photo-send').disabled = true;
  try {
    const token = net.lastToken || await net.token();
    await new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open('POST', `/eboard-api/call/photo?grant=${grant.id}&name=${encodeURIComponent(photoFile.name || 'photo.jpg')}`);
      x.setRequestHeader('Authorization', 'Bearer ' + token);
      x.upload.onprogress = (e) => {
        if (!e.lengthComputable) return;
        const p = Math.round((e.loaded / e.total) * 100);
        $('i', bar).style.width = `${p}%`; $('span', bar).textContent = p < 100 ? `보내는 중… ${p}%` : '선생님께 전달하는 중…';
      };
      x.onload = () => {
        let j = {}; try { j = JSON.parse(x.responseText); } catch { /* 무시 */ }
        if (x.status < 300) resolve(j); else reject(new Error((j.detail && j.detail.message) || `보내지 못했습니다 (${x.status})`));
      };
      x.onerror = () => reject(new Error('인터넷 연결을 확인하세요'));
      x.send(photoFile);
    });
    $('#photo-msg').textContent = '보냈습니다! 선생님이 확인하는 중이에요.';
    $('#photo-send').hidden = true;
  } catch (e) {
    toast(e.message, 3500);
  } finally {
    bar.hidden = true; $('#photo-send').disabled = false;
  }
}

// ── 칠판에 풀기 ──
function ensureBoard() {
  if (board) return;
  board = new Board();
  renderer = new Renderer($('#stage'));
  renderer.board = board;
  vbg = new VideoBg({ net, renderer, toast, canControl: () => false, audible: () => !!(grant && grant.home) });
  tools = new Tools({ board, renderer, net, getPageId: () => board.page?.id, onChange: syncBar });
  tools.canEdit = (o) => mine.has(o.id);
  tools.tool = 'pen'; tools.sizeIdx = 1;
  // 내가 보낸 동작으로 '내 것' 목록 관리
  const send = net.send.bind(net);
  net.send = (pageId, ops) => {
    for (const op of ops) { if (op.k === 'add') mine.add(op.id); else if (op.k === 'remove') mine.delete(op.id); }
    send(pageId, ops);
  };
  buildBar();
}

function loadPage(payload) {
  const changed = board.page && board.page.id !== payload.page.id;
  board.load(payload.page);
  for (const op of net.unconfirmed(board.page.id)) board.apply(op);
  renderer.setPage(board.page.w, board.page.h);
  tools.usePage(board.page.id);
  vbg.onPage(board.page);
  if (changed) toast('선생님이 다른 페이지로 옮겼습니다');
}

function startSolve(payload) {
  ensureBoard();
  if (grant.home && !rx) rx = new Receiver(net, { toast });
  show('solve');
  loadPage(payload);
  applyMode();
  net.resend();
}

// 원격 참여: 보기만(손들기) ↔ 칠판에 쓰기(선생님이 허락)
function applyMode() {
  if (!grant || !tools) return;
  const write = grant.mode === 'solve';
  tools.readOnly = !write;
  document.body.classList.toggle('stu-watch', !write);
  $('#solve-done').hidden = !write;
  $('#solve-hand').hidden = !grant.home;
  $('#solve-hand').classList.toggle('on', !!grant.hand);
  $('#solve-hand').textContent = grant.hand ? '✋ 손 내리기' : '✋ 손들기';
  $('#solve-done').classList.toggle('on', !!grant.done);
  $('#solve-msg').textContent = write ? '칠판에 바로 보입니다. 내가 쓴 것만 지울 수 있어요.' : '선생님 칠판을 보는 중이에요. 질문이 있으면 손을 드세요.';
  $('#mode-label').textContent = grant.home ? (write ? '원격 참여 · 칠판에 쓰기' : '원격 참여') : '칠판에 풀기';
  if (renderer) requestAnimationFrame(() => renderer.resize());
}

async function toggleHand() {
  if (!grant) return;
  const r = await net.call('call:hand', { id: grant.id }).catch(() => null);
  if (r && r.ok) { grant.hand = r.hand; applyMode(); }
}

function onOpBatch(d) {
  if (!board || !board.page || d.page_id !== board.page.id) return;
  if (d.from > board.seq + 1) {
    net.call('page:state', {}).then((r) => r && r.ok && loadPage(r)).catch(() => {});
    return;
  }
  if (d.cid !== net.cid) {
    for (const op of d.ops) {
      if (op.s > board.seq) board.apply(op);
      if (op.k === 'remove') mine.delete(op.id);       // 선생님이 지운 경우
      if (op.k === 'add') tools.remoteCommitted(op.id);
    }
    renderer.requestMain();
  }
  board.seq = Math.max(board.seq, d.to);
}

function buildBar() {
  const bar = $('#toolbar');
  const btn = (cls, html, title, fn) => { const b = document.createElement('button'); b.type = 'button'; b.className = cls; b.innerHTML = html; b.title = title; b.onclick = fn; bar.appendChild(b); return b; };
  btn('tool', '<svg viewBox="0 0 24 24"><path d="M4 20l4-1 11-11-3-3L5 16z"/></svg><span>펜</span>', '펜', () => { tools.tool = 'pen'; syncBar(); }).dataset.tool = 'pen';
  btn('tool', '<svg viewBox="0 0 24 24"><path d="M7 20h10M5 14l7-7 6 6-6 6H9z"/></svg><span>지우개</span>', '지우개', () => { tools.tool = 'erase'; syncBar(); }).dataset.tool = 'erase';
  for (const c of STU_COLORS) {
    const b = btn('swatch', '', '색', () => { tools.color = c; tools.tool = 'pen'; syncBar(); });
    b.style.setProperty('--c', c); b.dataset.color = c;
  }
  [0, 1, 2].forEach((i) => { const b = btn('size', `<i style="--d:${[6, 11, 18][i]}px"></i>`, ['가늘게', '보통', '굵게'][i], () => { tools.sizeIdx = i; syncBar(); }); b.dataset.size = i; });
  btn('act undo', '<svg viewBox="0 0 24 24"><path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 010 12h-3"/></svg><span>되돌림</span>', '되돌림', () => tools.undo());
  btn('act redo', '<svg viewBox="0 0 24 24"><path d="M15 14l5-5-5-5"/><path d="M20 9H10a6 6 0 000 12h3"/></svg><span>다시</span>', '다시', () => tools.redo());
  btn('act fit', '<svg viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg><span>맞춤</span>', '화면 맞춤', () => renderer.fit());
  syncBar();
}

function syncBar() {
  if (!tools) return;
  document.querySelectorAll('#toolbar .tool').forEach((b) => b.classList.toggle('on', b.dataset.tool === tools.tool || (b.dataset.tool === 'erase' && tools.tool === 'erasePart')));
  document.querySelectorAll('#toolbar .swatch').forEach((b) => b.classList.toggle('on', b.dataset.color === tools.color));
  document.querySelectorAll('#toolbar .size').forEach((b) => b.classList.toggle('on', +b.dataset.size === tools.sizeIdx));
  const u = $('#toolbar .undo'), r = $('#toolbar .redo');
  if (u) { u.disabled = !tools.undoStack.length; r.disabled = !tools.redoStack.length; }
}

async function toggleDone() {
  if (!grant) return;
  const r = await net.call('call:done', { id: grant.id }).catch(() => null);
  if (!r || !r.ok) return;
  grant.done = r.done;
  $('#solve-done').classList.toggle('on', r.done);
  $('#solve-done').textContent = r.done ? '다 했어요 ✓ (선생님께 알림)' : '다 했어요';
}

// ── 연결 ──
async function resume() {
  const r = await net.call('call:mine', {}).catch(() => null);
  if (!r || !r.ok) return;
  const g = r.grants[0];
  if (!g) { if (grant) { grant = null; show('wait'); } return; }
  if (g.status === 'waiting') { onInvite(g); return; }
  grant = g;
  if (g.mode === 'photo') { if ($('#photo').hidden) { resetPhoto(); show('photo'); } if (g.status === 'submitted') $('#photo-msg').textContent = '보냈습니다! 선생님이 확인하는 중이에요.'; return; }
  accept();                                         // 풀이 중에 끊겼다가 다시 연결: 칠판으로 다시 들어감
}

function start() {
  net = new Net('student');
  net.addEventListener('connect', () => { setStatus('ok', '연결됨'); resume(); });
  net.addEventListener('disconnect', () => setStatus('bad', '끊김 · 다시 연결 중'));
  net.addEventListener('connect-error', () => setStatus('bad', '연결 실패 · 다시 시도 중'));
  net.addEventListener('auth-error', (e) => {
    if (e.detail.code === 'not_logged_in') { net.socket.disconnect(); setStatus('bad', '로그인 필요'); $('#login-needed').hidden = false; }
  });
  net.addEventListener('hello', (e) => {
    const sv = e.detail.server_version;
    if (sv && sv !== document.body.dataset.v && $('#solve').hidden && $('#photo').hidden) location.reload();
  });
  net.addEventListener('call:invite', (e) => onInvite(e.detail));
  net.addEventListener('call:ended', (e) => onEnded(e.detail));
  net.addEventListener('call:state', (e) => {
    if (e.detail.msg) toast(e.detail.msg, 3500);
    if (grant && e.detail.id === grant.id && e.detail.status === 'active' && grant.mode === 'photo') { resetPhoto(); $('#photo-msg').textContent = e.detail.msg; }
    if (grant && e.detail.id === grant.id && grant.home) { grant.mode = e.detail.mode; grant.hand = e.detail.hand; applyMode(); }
  });
  net.addEventListener('op:batch', (e) => onOpBatch(e.detail));
  net.addEventListener('stroke:live', (e) => { if (board && board.page && e.detail.page_id === board.page.id) tools.remoteLive(e.detail); });
  net.addEventListener('page:current', (e) => { if (board && grant && (grant.mode === 'solve' || grant.home)) loadPage(e.detail); });
  net.addEventListener('page:color', (e) => {          // 칠판 배경색
    const d = e.detail;
    if (!board || !board.page || d.page_id !== board.page.id) return;
    board.page.bg_color = d.bg_color || null;
    renderer.requestMain(); renderer.requestLive();
  });
  net.addEventListener('page:bg', (e) => {
    const d = e.detail;
    if (!board || !board.page || d.page_id !== board.page.id) return;
    board.page.bg_type = d.bg_type; board.page.bg_meta = d.bg_meta; board.page.bg_url = d.bg_url || null;
    board.page.play = d.play || null;
    vbg.onPage(board.page);
    renderer.requestMain();
  });
  net.addEventListener('rejected', (e) => { if (e.detail.error === 'not_yours') toast('친구나 선생님이 쓴 것은 지울 수 없어요'); });
  net.connect();

  $('#invite-ok').onclick = accept;
  $('#invite-no').onclick = decline;
  $('#photo-cam').onchange = (e) => pickPhoto(e.target.files[0]);
  $('#photo-file').onchange = (e) => pickPhoto(e.target.files[0]);
  $('#photo-send').onclick = sendPhoto;
  $('#solve-done').onclick = toggleDone;
  $('#solve-hand').onclick = toggleHand;
  // 학생 화면은 꺼지지 않게(지원하는 브라우저에서)
  const wake = async () => { try { if (navigator.wakeLock && document.visibilityState === 'visible') await navigator.wakeLock.request('screen'); } catch { /* 무시 */ } };
  document.addEventListener('visibilitychange', wake); wake();
  window.__stu = { get net() { return net; }, get board() { return board; }, get tools() { return tools; }, get renderer() { return renderer; }, mine };
}

start();
