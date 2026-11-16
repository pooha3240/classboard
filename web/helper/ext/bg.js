// classboard 전자칠판 도우미 본체(JMSchool 전자칠판 도우미에서 옮김): 탭마다 무작위 표(token)를 기억하고, 칠판이 보낸 조작을 그 탭(과 그 안의 틀)으로 전달
// 이 도우미를 받은 칠판 주소(칠판이 내려줄 때 채움). 이 주소의 칠판만 조작을 보낼 수 있음
const ORIGIN = '__BOARD_ORIGIN__';
const BOARD = [new RegExp('^' + ORIGIN.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&') + '/')];
const S = chrome.storage.session;
const mem = new Map();          // 'k:'+token → tabId, 'f:'+nonce → frameId
const last = new Map();         // tabId → 마지막으로 누른 틀(글자 입력을 보낼 곳)
const queue = new Map();        // tabId → 차례대로 보내기
const touched = new Map();      // tabId → 칠판에서 마지막으로 누른 때(새 창 → 같은 탭 열기는 그 직후만)

async function get(key) {
  if (mem.has(key)) return mem.get(key);
  const o = await S.get(key);
  if (key in o) mem.set(key, o[key]);
  return o[key];
}
function put(key, val) { mem.set(key, val); S.set({ [key]: val }).catch(() => {}); }

chrome.runtime.onMessage.addListener((m, s, reply) => {
  if (!m || !m.t) return;
  if (m.t === 'reg' && s.tab && s.frameId === 0) { put('k:' + m.token, s.tab.id); return; }
  if (m.t === 'fid' && s.tab) { if (!mem.has('f:' + m.nonce)) put('f:' + m.nonce, s.frameId); return; }
  if (m.t === 'getfid') { get('f:' + m.nonce).then((v) => reply(v ?? null)); return true; }
  if (m.t === 'nav' && s.tab && /^https?:/.test(m.url || '') && Date.now() - (touched.get(s.tab.id) || 0) < 2500) { chrome.tabs.update(s.tab.id, { url: m.url }); return; }
  if (m.t === 'ctl') {
    if (!s.url || !BOARD.some((r) => r.test(s.url))) { reply({ err: 'origin' }); return; }
    (async () => {
      const tab = await get('k:' + m.token);
      if (tab == null) return { err: 'notab' };
      const prev = queue.get(tab) || Promise.resolve();
      const job = prev.then(() => route(tab, m.ev)).catch((e) => ({ err: 'send', msg: String(e && e.message || e) }));
      queue.set(tab, job);
      return job;
    })().then(reply);
    return true;
  }
});

const TEXTY = new Set(['text', 'key', 'select']);
async function route(tab, ev) {
  if (ev.k !== 'hover' && ev.k !== 'size') touched.set(tab, Date.now());
  let frameId = TEXTY.has(ev.k) ? (last.get(tab) ?? 0) : 0;
  let r = null;
  for (let hop = 0; hop < 6; hop++) {
    try { r = await chrome.tabs.sendMessage(tab, { ebx: ev }, { frameId }); } catch (e) {
      if (frameId !== 0 && TEXTY.has(ev.k)) { last.delete(tab); frameId = 0; continue; }
      throw e;
    }
    if (r && r.fwd != null) { frameId = r.fwd; ev = { ...ev, x: r.x, y: r.y, abs: true }; continue; }
    break;
  }
  if (ev.k === 'down') last.set(tab, frameId);
  return r || {};
}

chrome.tabs.onRemoved.addListener((tab) => { last.delete(tab); queue.delete(tab); touched.delete(tab); });

// 깔거나 다시 읽은 직후: 이미 열려 있는 탭에도 넣어서 새로고침(F5) 없이 바로 쓰게
chrome.runtime.onInstalled.addListener(async () => {
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) {
    if (!t.id || !/^(https?|file):/.test(t.url || '')) continue;
    const target = { tabId: t.id, allFrames: true };
    chrome.scripting.executeScript({ target, files: ['main.js'], world: 'MAIN', injectImmediately: true }).catch(() => {});
    chrome.scripting.executeScript({ target, files: ['page.js'], injectImmediately: true }).catch(() => {});
    if (BOARD.some((r) => r.test(t.url))) chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['bridge.js'] }).catch(() => {});
  }
});

// ── 이 탭을 전자칠판에 띄우기: 띄울 탭에서 도우미 아이콘·Alt+Shift+E·오른쪽 클릭 메뉴 ──
// 크롬 화면 공유(getDisplayMedia)와 달리 칠판 위쪽에 '공유 중' 막대가 생기지 않음.
// 확장 탭 캡처는 사용자가 그 탭에서 확장을 직접 부른 경우에만 허락되므로(activeTab) 칠판에서 바로 시작할 수는 없음
const BOARD_PAGE = /^\/(index\.html)?(\?|#|$)/;   // 칠판 화면(/). 설정·기록·진도표·학생 화면은 아님
function flag(tabId, text, title) {
  chrome.action.setBadgeBackgroundColor({ tabId, color: text === '!' ? '#d7263d' : '#1e8a4c' }).catch(() => {});
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  if (title) chrome.action.setTitle({ tabId, title }).catch(() => {});
}
async function cast(tab) {
  if (!tab || !tab.id) return;
  if (BOARD.some((r) => r.test(tab.url || '')) && BOARD_PAGE.test(new URL(tab.url).pathname + new URL(tab.url).search)) {
    flag(tab.id, '!', '칠판 화면이 아니라 띄울 탭(아이스크림 등)에서 누르세요'); return;
  }
  const boards = (await chrome.tabs.query({})).filter((t) => t.id !== tab.id && BOARD.some((r) => r.test(t.url || '')) && BOARD_PAGE.test((() => { try { const u = new URL(t.url); return u.pathname + u.search; } catch { return ''; } })()));
  if (!boards.length) { flag(tab.id, '!', '전자칠판(칠판 화면)이 열려 있지 않습니다. 칠판을 먼저 여세요'); return; }
  boards.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
  let streamId;
  try { streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id, consumerTabId: boards[0].id }); } catch (e) {
    flag(tab.id, '!', '띄우지 못했습니다: ' + (e && e.message || e)); return;
  }
  const secret = crypto.randomUUID();
  put('k:' + secret, tab.id);
  let ok = null;
  try { ok = await chrome.tabs.sendMessage(boards[0].id, { ebxCast: { streamId, secret, title: tab.title || '', url: tab.url || '' } }, { frameId: 0 }); } catch { ok = null; }
  if (ok && ok.ok) flag(tab.id, '칠판', '전자칠판에 띄우는 중입니다(칠판의 끄기로 멈춤)');
  else flag(tab.id, '!', '칠판이 답하지 않습니다. 칠판을 새로고침한 뒤 다시 누르세요');
}
chrome.action.onClicked.addListener(cast);
chrome.contextMenus.onClicked.addListener((info, tab) => { if (info.menuItemId === 'ebx-cast') cast(tab); });
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => chrome.contextMenus.create({ id: 'ebx-cast', title: '이 탭을 전자칠판에 띄우기', contexts: ['page', 'frame', 'link', 'image', 'video'] }));
});
chrome.runtime.onMessage.addListener((m, s) => {
  if (m && m.t === 'castEnded' && typeof m.secret === 'string') {
    get('k:' + m.secret).then((tabId) => { if (tabId != null) flag(tabId, '', '이 탭을 전자칠판에 띄우기 (Alt+Shift+E)'); });
  }
});
