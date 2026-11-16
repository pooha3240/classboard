// 칠판 쪽 다리: 칠판 화면(이 확장이 허용한 주소만)이 보낸 조작을 확장으로 넘기고 답을 돌려줌
(() => {
  const alive = () => { try { return !!chrome.runtime.id; } catch { return false; } };
  if (window.__ebxBridge && window.__ebxBridge()) return;
  window.__ebxBridge = alive;
  const V = chrome.runtime.getManifest().version;
  window.addEventListener('message', async (e) => {
    if (e.source !== window || !e.data || !e.data.__ebx || !alive()) return;
    const { id, op, token, ev } = e.data.__ebx;
    let res;
    if (op === 'hello') res = { v: V };
    else if (op === 'castEnded') { chrome.runtime.sendMessage({ t: 'castEnded', secret: e.data.__ebx.secret }).catch(() => {}); res = { ok: true }; }
    else if (op === 'ctl') {
      try { res = await chrome.runtime.sendMessage({ t: 'ctl', token, ev }); } catch (err) { res = { err: 'ext', msg: String(err && err.message || err) }; }
    }
    window.postMessage({ __ebxr: { id, res: res || null } }, location.origin);
  });
  // 확장이 '이 탭을 칠판에 띄우기'를 하면 칠판 화면에 알림
  chrome.runtime.onMessage.addListener((m, s, reply) => {
    if (!m || !m.ebxCast) return;
    window.postMessage({ __ebxcast: m.ebxCast }, location.origin);
    reply({ ok: true });
  });
  const markIt = () => document.documentElement && document.documentElement.setAttribute('data-ebx-helper', V);
  markIt();
  document.addEventListener('DOMContentLoaded', markIt);
})();
