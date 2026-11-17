// 칠판 화면 시작점: 학급 선택, 연결, 페이지, 도구 막대
// classboard: jmschool판 app.js 를 바탕으로, 로그인(login.html)·학급 하나 구조에 맞게 고쳤습니다.
import { Board } from './model.js';
import { Renderer, renderPageCanvas, canvasToWebp } from './render.js';
import { Net, savedToken, clearToken } from './net.js';
import { Tools, COLORS, SIZES } from './tools.js';
import { askPin } from './pin.js';
import { ClassTools } from './classtools.js';
import { MathTools } from './mathtools.js';
import { MediaTools } from './media.js';
import { askConfirm } from './ui.js';
import { QuickBar } from './quick.js';
import { JointTools } from './joint.js';
import { CallTools } from './calls.js';
import { VideoBg } from './video.js';
import { TodayPanel } from './today.js';
import { ColorPicker } from './palette.js';
import { loadBgImage, isImageBg } from './shapes.js';

const $ = (s, el = document) => el.querySelector(s);
const store = {
  get(k, d) { try { const v = localStorage.getItem('eboard.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('eboard.' + k, JSON.stringify(v)); } catch { /* 저장 불가 환경 */ } },
};

const DEVICE_LABEL = { display: '전자칠판', 'teacher-pc': '교사 PC', 'teacher-tablet': '교사 태블릿' };

const board = new Board();
const renderer = new Renderer($('#stage'));
renderer.board = board;

let deviceKey = store.get('deviceKey', null);   // 등록된 전자칠판의 기기 키
let device = deviceKey ? 'display' : store.get('device', null);
let klass = store.get('class', null);       // {grade, class}
let pages = [];
let session = null;            // 현재 수업 세션 {id, date, label, subject}
let peers = [];
const snapSeq = new Map();     // 페이지별로 마지막으로 올린 스냅샷의 seq
let net = null;
let tools = null;
let classTools = null;
let mathTools = null;
let mediaTools = null;
let callTools = null;
let quickBar = null;
let jointTools = null;
let videoBg = null;
const colorPicker = new ColorPicker();
let joined = false;

function toast(msg, ms = 2200) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), ms);
}

function setStatus(state, text) {
  const el = $('#conn');
  el.dataset.state = state;
  $('#conn-text').textContent = text;
}

// ── 페이지 ──
// ── 스냅샷: 기록 보기의 썸네일과 PDF 에 쓰입니다 ──
function snapshotAllowed() {
  // 전자칠판이 있으면 전자칠판만, 없으면 아무 교사 기기나 올립니다(서버가 오래된 것은 무시).
  // 합반 수업을 보기 전용으로 보는 기기는 올리지 않음(진행 학급 기기가 올림)
  if (jointTools && jointTools.viewer) return false;
  return device === 'display' || !peers.some((p) => p.device === 'display');
}

async function snapshot(page, objs, seq) {
  if (!page || !snapshotAllowed() || !net) return;
  if (!seq && !isImageBg(page)) return;               // 빈 페이지는 올리지 않음(자료만 있는 페이지는 올림)
  if (snapSeq.has(page.id) && snapSeq.get(page.id) >= seq) return;
  snapSeq.set(page.id, seq);
  try {
    await loadBgImage(page);
    const thumb = await canvasToWebp(renderPageCanvas(objs, page.w, page.h, 400, page), 0.8);
    if (!thumb) return;                                // 기본판: 기록 목록용 미리보기만 올림
    const t = net.lastToken || await net.token();
    const r = await fetch(`/eboard-api/pages/${page.id}/snapshot`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t },
      body: JSON.stringify({ seq, thumb }),
    });
    if (!r.ok) snapSeq.delete(page.id);
  } catch { snapSeq.delete(page.id); }
}

function snapshotCurrent() {
  return board.page ? snapshot({ ...board.page }, [...board.objs.values()], board.seq) : Promise.resolve();
}

function renderSession() {
  const el = $('#session-label');
  if (!session) { el.textContent = ''; if ($('#lesson-label')) $('#lesson-label').hidden = true; return; }
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
  const day = session.date === today ? '' : session.date.slice(5).replace('-', '/') + ' ';
  el.textContent = `${day}${session.label}${session.subject ? ' · ' + session.subject : ''}`;
  const ls = $('#lesson-label');                     // 진도표 차시(단원 n/m차시 · 학습주제)
  if (ls) { ls.textContent = session.lesson || ''; ls.title = session.lesson || ''; ls.hidden = !session.lesson; }
}

function loadPage(payload) {
  // 떠나는 페이지의 스냅샷
  if (board.page && board.page.id !== payload.page.id) snapshotCurrent();
  pages = payload.pages;
  if (payload.session) { session = payload.session; renderSession(); }
  board.load(payload.page);
  if (mediaTools) mediaTools.onPageChange(board.page);
  if (videoBg) videoBg.onPage(board.page);
  if (quickBar) setTimeout(() => quickBar.sync(), 0);
  // 아직 서버가 확정하지 않은 내 동작을 새 상태 위에 다시 적용
  for (const op of net.unconfirmed(board.page.id)) board.apply(op);
  renderer.setPage(board.page.w, board.page.h);
  tools.usePage(board.page.id);
  renderPageNav();
  if (mediaTools) mediaTools.sync();
}

function renderPageNav() {
  const i = pages.findIndex((p) => p.id === board.page?.id);
  $('#page-label').textContent = pages.length ? `${i + 1} / ${pages.length}` : '-';
  $('#btn-prev').disabled = i <= 0;
  $('#btn-next').disabled = i < 0 || i >= pages.length - 1;
}

async function gotoPage(delta) {
  const i = pages.findIndex((p) => p.id === board.page?.id);
  const target = pages[i + delta];
  if (!target) return;
  net.flush();
  const r = await net.call('page:goto', { page_id: target.id }).catch(() => null);
  if (!r || !r.ok) toast('페이지를 옮기지 못했습니다');
}

async function newPage() {
  net.flush();
  const r = await net.call('page:new', {}).catch(() => null);
  if (!r || !r.ok) toast('새 페이지를 만들지 못했습니다');
}

// ── 연결 ──
async function join() {
  if (net.deviceInfo) klass = { grade: net.deviceInfo.grade, class: net.deviceInfo.class };   // 등록 기기는 서버가 정한 학급
  if (!klass) return;
  const r = await net.call('room:join', { grade: klass.grade, class: klass.class }).catch(() => null);
  if (!r || !r.ok) { toast('학급 방에 들어가지 못했습니다'); return; }
  joined = true;
  $('#class-label').textContent = `${r.grade}학년 ${r.class}반`;
  loadPage(r);
  net.resend();
  callTools.refresh();
  jointTools.afterJoin(r);
  checkBells();
  // 기록 보기에서 '이어서 수업'으로 들어온 경우
  const openId = new URLSearchParams(location.search).get('open');
  if (openId) {
    history.replaceState(null, '', location.pathname + (location.search.includes('debug') ? '?debug' : ''));
    const elev = elevToken();
    const res = await net.call('session:open', { session_id: +openId, ...(elev ? { elev_token: elev } : {}) }).catch(() => null);
    if (!res || !res.ok) toast('그 판서를 열지 못했습니다' + (res && res.error ? ` (${res.error})` : ''));
  }
}

// 교시 시각이 기본값이면 알림(학교마다 종 시각이 다름). '나중에'는 오늘 하루만 숨김.
async function checkBells() {
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
  if (store.get('bellsLater', '') === today) return;
  try {
    const t = net.lastToken || await net.token();
    const r = await fetch('/eboard-api/settings/bells', { headers: { Authorization: 'Bearer ' + t } });
    const j = await r.json();
    $('#bell-banner').hidden = !(r.ok && j.default);
  } catch { /* 무시 */ }
}
$('#bell-banner-go').addEventListener('click', () => goPage('settings.html'));
$('#bell-banner-x').addEventListener('click', () => { store.set('bellsLater', new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' })); $('#bell-banner').hidden = true; });

function elevToken() {
  try {
    const e = JSON.parse(sessionStorage.getItem('eboard.elev') || 'null');
    return e && e.exp * 1000 > Date.now() + 5000 ? e.token : null;
  } catch { return null; }
}

// 등록 전자칠판은 PIN 을 풀어 교사 권한 토큰을 받음(10분). 로그인한 교사 기기는 그대로.
async function elevate(why) {
  if (!deviceKey) return net.lastToken || net.token();
  const have = elevToken();
  if (have) return have;
  const pin = await askPin('교사 PIN', why);
  if (!pin) return null;
  try {
    const r = await fetch('/eboard-api/auth/pin', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (net.lastToken || await net.token()) },
      body: JSON.stringify({ pin }),
    });
    const j = await r.json();
    if (!r.ok) { toast((j.detail && j.detail.message) || 'PIN 확인 실패', 3000); return null; }
    sessionStorage.setItem('eboard.elev', JSON.stringify({ token: j.token, exp: j.pin_until }));
    return j.token;
  } catch (e) { toast(e.message); return null; }
}

// 기록·설정 화면으로: 등록 전자칠판은 PIN 을 먼저
async function goPage(file) {
  if (deviceKey && !(await elevate(file === 'history.html' ? '판서 기록을 보려면 PIN 이 필요합니다' : file === 'plan.html' ? '진도표를 보려면 PIN 이 필요합니다' : '교시·시간표를 바꾸려면 PIN 이 필요합니다'))) return;
  // 기록에 지금 판서가 바로 보이도록 스냅샷을 올린 뒤 이동(최대 3초)
  await Promise.race([snapshotCurrent(), new Promise((r) => setTimeout(r, 3000))]);
  const q = klass ? `?grade=${klass.grade}&class=${klass.class}` : '';
  location.href = file + q;
}

// 교시가 바뀌었을 때
function onRollover(d) {
  loadPage(d);
  if (jointTools && jointTools.viewer) return;          // 보기 전용: 진행 교사가 알아서
  const bar = $('#rollover');
  if (!d.can_continue) { toast(`${session.label} 시작 · 새 판서로 바꿨습니다`, 4000); return; }
  $('#rollover-text').textContent = `${session.label} 시작 · 새 판서로 바꿨습니다.`;
  $('#rollover-continue').textContent = `${d.prev_label} 판서 이어쓰기`;
  $('#rollover-continue').onclick = async () => {
    bar.hidden = true;
    const r = await net.call('session:continue', { prev_session_id: d.prev_session_id }).catch(() => null);
    if (!r || !r.ok) toast(r && r.error === 'has_content' ? '새 판서에 이미 쓴 내용이 있어 이어쓸 수 없습니다' : '이어쓰지 못했습니다', 3500);
  };
  bar.hidden = false;
  clearTimeout(onRollover._t);
  onRollover._t = setTimeout(() => { bar.hidden = true; }, 5 * 60 * 1000);
}

function onOpBatch(d) {
  if (!board.page || d.page_id !== board.page.id) return;
  if (d.from > board.seq + 1) {                  // 중간이 빠짐 → 전체 상태 다시 받기
    net.call('page:state', {}).then((r) => r && r.ok && loadPage(r)).catch(() => {});
    return;
  }
  if (d.cid !== net.cid) {
    for (const op of d.ops) {
      if (op.s > board.seq) board.apply(op);
      if (op.k === 'add') tools.remoteCommitted(op.id);
    }
    renderer.requestMain();
  }
  board.seq = Math.max(board.seq, d.to);
}

function startNet() {
  net = new Net(device, deviceKey);
  tools = new Tools({ board, renderer, net, getPageId: () => board.page?.id, onChange: syncToolbar });
  classTools = new ClassTools({ net, device, toast, goPage, getClass: () => klass, getPeers: () => peers });
  mathTools = new MathTools({ tools, board, renderer, net, toast });
  tools.math = mathTools;
  mediaTools = new MediaTools({ net, board, renderer, toast });
  // 동영상 배경: 진행 기기(보기 전용 아님)가 조작, 소리는 전자칠판에서(합반 참여 반 전자칠판 포함, 진행 반에 전자칠판이 없으면 교사 기기)
  videoBg = new VideoBg({
    net, renderer, toast,
    canControl: () => !(jointTools && jointTools.viewer),
    audible: () => device === 'display' || !peers.some((p) => p.device === 'display' && !p.viewer),
  });
  mediaTools.video = videoBg;
  mediaTools.getClass = () => klass;
  mediaTools.colorPicker = colorPicker;
  // 오늘 시간표: 메뉴 막대의 교시·차시를 누르면 열림(나이스는 그대로 두고 수업만 바꿨을 때)
  const today = new TodayPanel({
    toast, getClass: () => klass, canEdit: () => !(jointTools && jointTools.viewer),
    token: () => net.lastToken || net.token(), elevate: () => elevate('시간표를 바꾸려면 PIN 이 필요합니다'),
    openMaterials: () => { if (mediaTools.panel.hidden) mediaTools.toggle(); },
  });
  void today;   // 오늘 시간표·진도는 다음 단계에서 엽니다
  callTools = new CallTools({ net, toast, sound: (id) => classTools.sound(id, true) });
  classTools.calls = callTools;
  jointTools = new JointTools({
    net, tools, toast, getClass: () => klass, rejoin: () => join(), loadPage: (r) => loadPage(r),
    api: async (path) => {
      const t = net.lastToken || await net.token();
      const res = await fetch('/eboard-api' + path, { headers: { Authorization: 'Bearer ' + t } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    },
    onViewer: (on, host) => {
      $('#class-label').textContent = on ? `${host} 합반 보는 중` : (klass ? `${klass.grade}학년 ${klass.class}반` : '학급 선택');
      classTools.close?.(); mathTools.panel.hidden = true; mediaTools.panel.hidden = true;
      requestAnimationFrame(() => { renderer.resize(); renderer.fit(); });   // 도구 막대가 숨거나 나타나 칠판 너비가 바뀜
      if (board.page) videoBg.onPage(board.page);
    },
  });
  callTools.joint = jointTools;
  callTools.getClass = () => klass;
  callTools.api = jointTools.c.api;
  jointTools.onStateChange = () => { if (callTools.tabBody && callTools.tabBody.isConnected) callTools.renderTab(callTools.tabBody, callTools.students); };
  quickBar = new QuickBar({
    classTools, mathTools, mediaTools, tools, renderer, board, goPage, toast,
    sync: () => syncToolbar(),
    clearPage: () => askConfirm('이 페이지의 판서를 모두 지울까요? 되돌림으로 다시 살릴 수 있습니다.', '모두 지우기', { danger: true }).then((ok) => ok && tools.clearPage()),
  });
  net.addEventListener('connect', () => { setStatus('ok', '연결됨'); join(); });
  net.addEventListener('disconnect', () => { joined = false; setStatus('bad', '끊김 · 다시 연결 중'); });
  net.addEventListener('connect-error', () => setStatus('bad', '연결 실패 · 다시 시도 중'));
  net.addEventListener('auth-error', (e) => {
    if (e.detail.code === 'device_revoked') {
      store.set('deviceKey', null);
      setStatus('bad', '기기 등록 해제됨');
      toast('이 전자칠판의 등록이 해제되었습니다. 교사 로그인으로 다시 등록하세요.', 4000);
      setTimeout(() => location.reload(), 3000);
      net.socket.disconnect();
      return;
    }
    if (e.detail.code === 'not_logged_in') {
      net.socket.disconnect();
      setStatus('bad', '로그인 필요');
      $('#login-needed').hidden = false;
    }
  });
  net.addEventListener('rtt', (e) => { $('#rtt').textContent = `${e.detail}ms`; });
  net.addEventListener('hello', (e) => {
    checkVersion(e.detail.server_version);
    // 로컬판: 학생 호출·전자칠판 등록·로그아웃처럼 다른 기기가 있어야 하는 메뉴를 숨김(css: body.ed-local)
    document.body.classList.toggle('ed-local', e.detail.edition === 'local');
  });
  net.addEventListener('op:batch', (e) => onOpBatch(e.detail));
  net.addEventListener('stroke:live', (e) => {
    if (board.page && e.detail.page_id === board.page.id) tools.remoteLive(e.detail);
  });
  net.addEventListener('page:current', (e) => { if (joined) loadPage(e.detail); });
  net.addEventListener('session:rollover', (e) => { if (joined) onRollover(e.detail); });
  net.addEventListener('session:meta', (e) => {         // 진도 조정으로 이 판서의 과목·차시가 바뀜
    const m = e.detail.session;
    if (session && m && m.id === session.id) { session = { ...session, ...m }; renderSession(); }
  });
  net.addEventListener('tool:event', (e) => {
    const d = e.detail;
    if (d.kind === 'instr' || d.kind === 'calib') mathTools.onRemote(d);
    else if (d.kind === 'camlive') mediaTools.onRemote(d);
    else classTools.onRemote(d);
  });
  net.addEventListener('page:bg', (e) => {
    const d = e.detail;
    if (!board.page || d.page_id !== board.page.id) return;
    board.page.bg_type = d.bg_type; board.page.bg_meta = d.bg_meta; board.page.bg_url = d.bg_url || null;
    board.page.play = d.play || null;
    videoBg.onPage(board.page);
    snapSeq.delete(board.page.id);                    // 배경이 바뀌면 스냅샷도 다시
    renderer.requestMain(); mathTools._syncPanel(); mediaTools.sync(); quickBar && quickBar.sync();
  });
  net.addEventListener('page:color', (e) => {      // 칠판 배경색
    const d = e.detail;
    if (!board.page || d.page_id !== board.page.id) return;
    board.page.bg_color = d.bg_color || null;
    snapSeq.delete(board.page.id);
    renderer.requestMain(); renderer.requestLive(); mediaTools.sync(); quickBar && quickBar.sync();
  });
  net.addEventListener('room:peers', (e) => {
    peers = e.detail.peers;
    const names = e.detail.peers.map((p) => (p.device === 'student' ? `학생 ${p.name}` : DEVICE_LABEL[p.device] || p.device));
    const cnt = new Map();
    names.forEach((n) => cnt.set(n, (cnt.get(n) || 0) + 1));
    $('#peers').textContent = [...cnt].map(([n, c]) => (c > 1 ? `${n} ${c}` : n)).join(' · ');
    $('#peers').title = `접속 기기 ${names.length}대`;
  });
  net.addEventListener('rejected', (e) => toast('저장되지 않은 동작이 있습니다: ' + (e.detail.error || '')));
  net.connect();
  setStatus('wait', '연결 중');
  buildToolbar();
}

// ── 배포 후 옛 화면이 남지 않게: 서버 버전이 다르면 새로 고침 ──
let lastInput = Date.now();
document.addEventListener('pointerdown', () => { lastInput = Date.now(); }, true);
function checkVersion(sv) {
  const mine = document.body.dataset.v;
  if (!sv || !mine || sv === mine || checkVersion.t) return;
  if (device !== 'display') { $('#update-banner').hidden = false; return; }
  // 전자칠판: 20초 동안 아무도 쓰지 않을 때 스냅샷을 올리고 새로 고침
  checkVersion.t = setInterval(async () => {
    if (Date.now() - lastInput < 20000 || (tools && tools.pointers.size)) return;
    clearInterval(checkVersion.t);
    net.flush();
    await Promise.race([snapshotCurrent(), new Promise((r) => setTimeout(r, 3000))]);
    location.reload();
  }, 5000);
}
$('#update-reload').addEventListener('click', () => location.reload());

// ── 도구 막대 ──
const TOOL_LIST = [
  ['pen', '펜', '<path d="M4 20l4-1 11-11-3-3L5 16z"/>'],
  ['hl', '형광펜', '<path d="M6 18l3 2 10-10-5-5L4 15z"/><path d="M3 21h8"/>'],
  ['erase', '지우개', '<path d="M7 20h10M5 14l7-7 6 6-6 6H9z"/>'],
  ['select', '선택', '<path d="M5 3l14 8-6 2-2 6z"/>'],
  ['shape', '수학', '<path d="M4 20L12 5l8 15z"/><circle cx="12" cy="15" r="2.5"/>'],
];

function icon(svgPath) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${svgPath}</svg>`;
}

function buildToolbar() {
  const bar = $('#toolbar');
  bar.innerHTML = '';
  const group = (cls) => { const g = document.createElement('div'); g.className = 'group ' + cls; bar.appendChild(g); return g; };

  const gt = group('tools');
  for (const [id, label, svg] of TOOL_LIST) {
    const b = document.createElement('button');
    b.className = 'tool'; b.dataset.tool = id; b.title = label;
    b.innerHTML = icon(svg) + `<span>${label}</span>`;
    b.addEventListener('click', () => {
      if (id === 'erase') {                   // 지우개를 다시 누르면 획 ↔ 부분 전환
        tools.tool = tools.tool === 'erase' ? 'erasePart' : tools.tool === 'erasePart' ? 'erase' : 'erase';
      } else if (id === 'shape') {
        if (tools.tool !== 'shape') { tools.tool = 'shape'; mathTools.panel.hidden = false; } else mathTools.toggle();
      } else {
        tools.tool = id;
      }
      if (tools.tool !== 'select') tools.selection.clear();
      if (tools.tool !== 'shape') mathTools.resetTaps();
      renderer.requestLive(); syncToolbar();
    });
    gt.appendChild(b);
  }

  const gc = group('colors');
  COLORS.forEach((c) => {
    const b = document.createElement('button');
    b.className = 'swatch'; b.dataset.color = c; b.style.setProperty('--c', c); b.title = '색';
    b.addEventListener('click', () => { tools.color = c; if (tools.tool !== 'pen' && tools.tool !== 'hl') tools.tool = 'pen'; syncToolbar(); });
    gc.appendChild(b);
  });
  // 마지막 칸: 색 고르기 창(고른 색이 이 칸에 남음)
  const pal = document.createElement('button');
  pal.className = 'swatch pal'; pal.title = '다른 색 고르기'; pal.setAttribute('aria-label', '다른 색 고르기');
  pal.addEventListener('click', () => colorPicker.open(pal, {
    kind: 'ink', title: '글씨 색', current: tools.color,
    onPick: (c) => { tools.color = c; if (tools.tool !== 'pen' && tools.tool !== 'hl') tools.tool = 'pen'; syncToolbar(); },
  }));
  gc.appendChild(pal);

  const gs = group('sizes');
  [0, 1, 2].forEach((i) => {
    const b = document.createElement('button');
    b.className = 'size'; b.dataset.size = i; b.title = ['가늘게', '보통', '굵게'][i];
    b.innerHTML = `<i style="--d:${[6, 11, 18][i]}px"></i>`;
    b.addEventListener('click', () => { tools.sizeIdx = i; syncToolbar(); });
    gs.appendChild(b);
  });

  const ga = group('actions');
  const act = (cls, label, svg, fn) => {
    const b = document.createElement('button');
    b.className = 'act ' + cls; b.title = label;
    b.innerHTML = icon(svg) + `<span>${label}</span>`;
    b.addEventListener('click', fn);
    ga.appendChild(b);
    return b;
  };
  act('undo', '되돌림', '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 010 12h-3"/>', () => tools.undo());
  act('redo', '다시', '<path d="M15 14l5-5-5-5"/><path d="M20 9H10a6 6 0 000 12h3"/>', () => tools.redo());
  act('del', '선택 삭제', '<path d="M5 7h14M10 11v6M14 11v6M7 7l1 13h8l1-13M9 7V4h6v3"/>', () => tools.deleteSelection());
  act('clear', '전체 지우기', '<path d="M4 4l16 16M20 4L4 20"/>', () => {
    askConfirm('이 페이지의 판서를 모두 지울까요? 되돌림으로 다시 살릴 수 있습니다.', '모두 지우기', { danger: true }).then((ok) => ok && tools.clearPage());
  });
  act('classtools', '수업 도구', '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><circle cx="16.5" cy="16.5" r="3.5"/>', () => classTools.toggle());
  act('fit', '화면 맞춤', '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>', () => renderer.fit());
  act('media', '자료', '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.5" cy="10" r="1.6"/><path d="M21 16l-5-5-8 8"/>', () => mediaTools.toggle());
  syncToolbar();
}

function syncToolbar() {
  if (!tools) return;
  for (const b of document.querySelectorAll('#toolbar .tool')) {
    const t = b.dataset.tool;
    b.classList.toggle('on', t === tools.tool || (t === 'erase' && tools.tool === 'erasePart'));
    if (t === 'erase') b.querySelector('span').textContent = tools.tool === 'erasePart' ? '부분 지우개' : '지우개';
  }
  if (mathTools) mathTools._syncPanel();
  for (const b of document.querySelectorAll('#toolbar .swatch:not(.pal)')) b.classList.toggle('on', b.dataset.color === tools.color);
  const pal = document.querySelector('#toolbar .swatch.pal');
  if (pal) {
    const custom = !COLORS.includes(tools.color);
    pal.classList.toggle('on', custom);
    pal.classList.toggle('picked', custom);
    pal.style.setProperty('--c', custom ? tools.color : 'transparent');
  }
  for (const b of document.querySelectorAll('#toolbar .size')) b.classList.toggle('on', +b.dataset.size === tools.sizeIdx);
  const q = (s) => document.querySelector('#toolbar .' + s);
  if (q('undo')) {
    q('undo').disabled = !tools.undoStack.length;
    q('redo').disabled = !tools.redoStack.length;
    q('del').hidden = !tools.selection.size;
    const pm = document.querySelector('#menu-penonly');
    if (pm) pm.textContent = (tools.penOnly ? '✓ ' : '') + '펜 전용 (손가락은 이동·확대)';
  }
}

// ── 학급·기기 선택 ──
async function api(path, token, opts = {}) {
  const r = await fetch('/eboard-api' + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, ...(opts.headers || {}) },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error((j.detail && j.detail.message) || ('HTTP ' + r.status));
    e.code = j.detail && j.detail.error;
    throw e;
  }
  return j;
}

function classButtons(box, list, onPick) {
  box.innerHTML = '';
  for (const c of list) {
    const b = document.createElement('button');
    b.className = 'chip' + (klass && klass.grade === c.grade && klass.class === c.class ? ' on' : '');
    b.textContent = `${c.grade}학년 ${c.class}반`;
    b.addEventListener('click', () => onPick(c));
    box.appendChild(b);
  }
  if (!list.length) box.innerHTML = '<p class="muted">학급이 없습니다</p>';
}

async function openPicker() {
  const dlg = $('#picker');
  const devBox = $('#picker-devices'), clsBox = $('#picker-classes'), reg = $('#picker-register');
  devBox.innerHTML = ''; clsBox.innerHTML = '<p class="muted">학급 목록을 불러오는 중…</p>';
  const showReg = () => { reg.hidden = device !== 'display'; };
  for (const [k, label] of Object.entries(DEVICE_LABEL)) {
    const b = document.createElement('button');
    b.textContent = label; b.className = 'chip' + (device === k ? ' on' : '');
    b.addEventListener('click', () => { device = k; [...devBox.children].forEach((c) => c.classList.toggle('on', c === b)); showReg(); });
    devBox.appendChild(b);
  }
  showReg();
  if (!dlg.open) dlg.showModal();
  let t;
  try {
    t = net ? (net.lastToken || await net.token()) : await new Net('teacher-pc').token();
    const [cls, ps] = await Promise.all([api('/classes', t), api('/auth/pin-status', t)]);
    $('#reg-pin-label').textContent = ps.has_pin ? 'PIN 바꾸기 (선택, 4~6자리)' : 'PIN 정하기 (4~6자리, 필수)';
    reg.dataset.needPin = ps.has_pin ? '' : '1';
    classButtons(clsBox, cls.classes, (c) => pickClass(c, t));
  } catch (e) {
    clsBox.innerHTML = `<p class="muted">불러오지 못했습니다 (${e.message})</p>`;
  }
}

async function pickClass(c, teacherToken) {
  if (!device) { toast('기기를 먼저 고르세요'); return; }
  const dlg = $('#picker');
  if (device === 'display' && $('#reg-on').checked) {
    const pin = $('#reg-pin').value.trim(), pin2 = $('#reg-pin2').value.trim();
    const need = !!$('#picker-register').dataset.needPin;
    if ((need || pin) && !/^\d{4,6}$/.test(pin)) { toast('PIN 은 숫자 4~6자리입니다'); return; }
    if (pin && pin !== pin2) { toast('PIN 확인이 다릅니다'); return; }
    try {
      const r = await api('/auth/device', teacherToken, {
        method: 'POST', body: JSON.stringify({ grade: c.grade, class: c.class, ...(pin ? { pin } : {}) }),
      });
      store.set('deviceKey', r.key); store.set('device', 'display'); store.set('class', { grade: c.grade, class: c.class });
      clearToken('teacher');            // 교실 기기에 30일짜리 교사 로그인을 남기지 않음(이제 기기 키로 동작)
      toast('전자칠판으로 등록했습니다');
      setTimeout(() => location.reload(), 600);
    } catch (e) { toast('등록하지 못했습니다: ' + e.message, 3500); }
    return;
  }
  const changedDevice = net && net.device !== device;
  klass = { grade: c.grade, class: c.class };
  store.set('class', klass); store.set('device', device);
  dlg.close();
  if (!net) startNet();
  else if (changedDevice) location.reload();
  else join();
}

// 등록된 전자칠판: PIN 을 넣어야 학급 변경·등록 해제
async function openDeviceMenu() {
  const pin = await askPin('교사 PIN', '학급을 바꾸거나 등록을 해제하려면 PIN 이 필요합니다');
  if (!pin) return;
  let elev;
  try {
    elev = await api('/auth/pin', net.lastToken || await net.token(), { method: 'POST', body: JSON.stringify({ pin }) });
  } catch (e) { toast(e.message, 3000); return; }
  sessionStorage.setItem('eboard.elev', JSON.stringify({ token: elev.token, exp: elev.pin_until }));
  const dlg = $('#devmenu'), box = $('#devmenu-classes');
  const k = net.deviceInfo || klass || {};
  box.innerHTML = `<p><b>${k.grade}학년 ${k.class}반</b> 전자칠판으로 등록되어 있습니다.</p>
    <p class="muted small">PIN 을 바꾸려면 교사 PC 에서 로그인해 전자칠판을 다시 등록하거나, 메뉴의 '등록된 전자칠판'에서 관리하세요.</p>`;
  dlg.showModal();
  $('#devmenu-revoke').onclick = async () => {
    if (!(await askConfirm('이 전자칠판의 등록을 해제할까요? 다시 쓰려면 교사 로그인이 필요합니다.', '등록 해제', { danger: true }))) return;
    try { await api('/auth/device', elev.token, { method: 'DELETE' }); } catch (e) { toast(e.message, 3000); return; }
    store.set('deviceKey', null);
    location.reload();
  };
  $('#devmenu-close').onclick = () => dlg.close();
}

// ── 시작 ──
if (store.get('barRight', false)) document.body.classList.add('bar-right');
// 높이 달린 전자칠판에서 손이 닿게: 기본은 위쪽 막대를 아래로, 도구는 아래쪽부터(기기마다 바꿀 수 있음)
if (store.get('barBottom', true)) document.body.classList.add('bar-bottom');
$('#btn-prev').addEventListener('click', () => gotoPage(-1));
$('#btn-next').addEventListener('click', () => gotoPage(1));
$('#btn-new').addEventListener('click', () => newPage());
$('#btn-menu').addEventListener('click', (e) => { e.stopPropagation(); $('#menu').hidden = !$('#menu').hidden; });
document.addEventListener('click', () => { $('#menu').hidden = true; });
$('#menu-new-session').addEventListener('click', async () => {
  if (!(await askConfirm('지금 판서는 기록에 남기고, 새 판서로 시작할까요?', '새 수업 시작'))) return;
  snapshotCurrent();
  const r = await net.call('session:new', {}).catch(() => null);
  if (!r || !r.ok) toast('새 수업을 시작하지 못했습니다');
});
$('#menu-history').addEventListener('click', () => goPage('history.html'));
$('#menu-settings').addEventListener('click', () => goPage('settings.html'));
$('#menu-plan').addEventListener('click', () => goPage('plan.html'));
$('#menu-pos').addEventListener('click', () => {
  const bottom = document.body.classList.toggle('bar-bottom'); store.set('barBottom', bottom);
  $('#menu').hidden = true;
  if (renderer) renderer.resize();
});
$('#menu-side').addEventListener('click', () => {
  const right = document.body.classList.toggle('bar-right'); store.set('barRight', right);
  requestAnimationFrame(() => renderer.resize());
});
$('#menu-roster').addEventListener('click', () => goPage('roster.php'));
$('#menu-joint').addEventListener('click', () => {
  $('#menu').hidden = true;
  if (!jointTools) return;
  if (jointTools.declined && !jointTools.viewer) jointTools.rejoinViewer(); else jointTools.open();
});
$('#menu-penonly').addEventListener('click', () => {
  if (!tools) return;
  tools.penOnly = !tools.penOnly; tools.autoPenOnly = false; syncToolbar();
  toast(tools.penOnly ? '펜으로만 씁니다. 손가락은 이동·확대' : '손가락으로도 씁니다');
});
$('#rollover-close').addEventListener('click', () => { $('#rollover').hidden = true; });
$('#menu-logout').addEventListener('click', () => { clearToken(); location.replace('login.html'); });
$('#menu-logout').hidden = !!deviceKey;          // 등록 전자칠판은 로그인이 없음(해제는 학급 버튼 → PIN)
$('#menu-devices').hidden = !!deviceKey;
$('#menu-devices').addEventListener('click', () => openDevices());

// 로그인한 교사 기기: 등록된 전자칠판 목록과 해제(잃어버렸거나 바꿨을 때)
async function openDevices() {
  const dlg = $('#devlist'), box = $('#devlist-items');
  box.innerHTML = '<p class="muted">불러오는 중…</p>';
  if (!dlg.open) dlg.showModal();
  let t;
  try {
    t = net.lastToken || await net.token();
    const r = await api('/auth/devices', t);
    if (!r.devices.length) { box.innerHTML = '<p class="muted">등록된 전자칠판이 없습니다. 전자칠판에서 로그인한 뒤 학급 버튼 → 전자칠판 → 등록하세요.</p>'; return; }
    box.innerHTML = r.devices.map((d) => `<div class="dev-row"><div><b>${d.label}</b> <span class="muted small">#${d.id}</span><br>
      <span class="muted small">등록 ${d.created_at} · 마지막 사용 ${d.last_seen}</span></div>
      <button type="button" class="chip danger" data-id="${d.id}">해제</button></div>`).join('');
    box.querySelectorAll('[data-id]').forEach((b) => {
      b.onclick = async () => {
        if (!(await askConfirm(`전자칠판 #${b.dataset.id} 의 등록을 해제할까요? 그 기기는 바로 칠판이 닫힙니다.`, '해제', { danger: true }))) return;
        try { await api(`/auth/devices/${b.dataset.id}`, t, { method: 'DELETE' }); toast('해제했습니다'); openDevices(); } catch (e) { toast(e.message, 3000); }
      };
    });
  } catch (e) { box.innerHTML = `<p class="muted">불러오지 못했습니다 (${e.message})</p>`; }
}
$('#devlist-close').addEventListener('click', () => $('#devlist').close());
setInterval(() => { if (board.page && (!snapSeq.has(board.page.id) || board.seq > snapSeq.get(board.page.id))) snapshotCurrent(); }, 60000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') snapshotCurrent(); });
$('#btn-class').addEventListener('click', () => (deviceKey ? openDeviceMenu() : openPicker()));
$('#btn-full').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen().catch(() => {});
});
document.addEventListener('keydown', (e) => {
  if (!tools) return;
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); e.shiftKey ? tools.redo() : tools.undo(); }
  else if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); tools.redo(); }
  else if (k === 'delete' || k === 'backspace') tools.deleteSelection();
});

// 전자칠판 화면이 꺼지지 않게
async function keepAwake() {
  try { if (device === 'display' && 'wakeLock' in navigator) await navigator.wakeLock.request('screen'); } catch { /* 미지원 */ }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') keepAwake(); });

if (!deviceKey && !savedToken()) location.replace('login.html');   // 로그인도 기기 키도 없음
else if (deviceKey || (device && klass)) { startNet(); keepAwake(); } else { openPicker(); }

// 시험용: 주소에 ?debug 가 있으면 내부 상태를 노출
if (new URLSearchParams(location.search).has('debug')) {
  window.__eboard = { board, renderer, get net() { return net; }, get tools() { return tools; }, get media() { return mediaTools; }, get video() { return videoBg; } };
}
