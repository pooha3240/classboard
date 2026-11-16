// 조작을 받는 탭(아이스크림 등)에서 도는 부분
//  1) 맨 위 문서는 무작위 표(token)를 만들어 확장에 등록하고, 이 탭을 화면 공유로 가져간 칠판만 그 표를 알 수 있게 함
//     (Capture Handle: 공유받은 쪽만 읽을 수 있음. 표를 모르면 조작을 보낼 수 없음)
//  2) 칠판에서 온 누르기·끌기·스크롤·글자를 이 문서의 그 위치 요소에 흉내 내어 보냄. 틀(iframe) 안이면 그 틀로 넘김
(() => {
  // 확장을 새로 깔거나 고쳐 다시 읽으면 열린 탭에도 다시 넣음 → 살아 있는 쪽이 이미 있으면 그만
  const alive = () => { try { return !!chrome.runtime.id; } catch { return false; } };
  if (window.__ebxPage && window.__ebxPage()) return;
  window.__ebxPage = alive;
  const TOP = window === window.top;
  const PID = 9999;                       // 흉내 낸 포인터 번호(main.js 와 같음)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  if (TOP) {
    const token = crypto.randomUUID();
    chrome.runtime.sendMessage({ t: 'reg', token }).catch(() => {});
    // 구글 문서·슬라이드는 자체 표를 씀(Meet 연동) → 건드리지 않음
    if (!/(^|\.)docs\.google\.com$/.test(location.hostname)) {
      try { navigator.mediaDevices && navigator.mediaDevices.setCaptureHandleConfig({ handle: 'ebx:' + token, exposeOrigin: true, permittedOrigins: ['*'] }); } catch { /* 지원 안 함 */ }
    }
  }

  // 부모 틀이 '너의 frameId 를 알려 달라'고 하면 확장에 알림(페이지 스크립트는 확장에 말할 수 없으므로 속일 수 없음)
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (d && typeof d === 'object' && typeof d.__ebxq === 'string' && e.source === window.parent && !TOP) {
      chrome.runtime.sendMessage({ t: 'fid', nonce: d.__ebxq }).catch(() => {});
    }
  });
  // 틀 안의 전체 화면 흉내: 바깥 문서들도 그 틀을 탭 화면 가득 채움(칠판에서 방금 누른 경우만)
  const FS_CSS = '[data-ebx-fsf]{position:fixed!important;left:0!important;top:0!important;width:100vw!important;height:100vh!important;max-width:none!important;max-height:none!important;margin:0!important;border:0!important;transform:none!important;z-index:2147483647!important;background:#000}';
  function fsFrame(ifr, on) {
    if (on && !document.getElementById('__ebx_fsf_css')) {
      const s = document.createElement('style'); s.id = '__ebx_fsf_css'; s.textContent = FS_CSS; (document.head || document.documentElement).appendChild(s);
    }
    document.querySelectorAll('[data-ebx-fsf]').forEach((e) => { if (e !== ifr || !on) e.removeAttribute('data-ebx-fsf'); });
    if (on) ifr.setAttribute('data-ebx-fsf', '');
    if (!TOP) window.parent.postMessage({ __ebxfs: on ? 'on' : 'off' }, '*');
  }
  document.addEventListener('__ebx_fs_state', (e) => { if (!TOP) window.parent.postMessage({ __ebxfs: e.detail }, '*'); });
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || typeof d !== 'object' || (d.__ebxfs !== 'on' && d.__ebxfs !== 'off')) return;
    const ifr = [...document.querySelectorAll('iframe,frame')].find((f) => f.contentWindow === e.source);
    if (!ifr) return;
    const recent = +(document.documentElement.getAttribute('data-ebx-g') || 0) > Date.now() - 3000;
    if (d.__ebxfs === 'on' && !recent) return;
    fsFrame(ifr, d.__ebxfs === 'on');
  });
  // 새 창 열기를 같은 탭에서(칠판에서 방금 누른 경우만 확장이 받아 줌)
  document.addEventListener('__ebx_open', (e) => { if (typeof e.detail === 'string') chrome.runtime.sendMessage({ t: 'nav', url: e.detail }).catch(() => {}); });

  chrome.runtime.onMessage.addListener((m, s, reply) => {
    if (!m || !m.ebx) return;
    run(m.ebx, window).then((r) => reply(r || {}), (err) => reply({ err: 'page', msg: String(err && err.message || err) }));
    return true;
  });

  // ── 창(window)마다 상태: 누르는 중인 동작, 마우스가 올라간 요소, 이어 누르기(더블클릭) ──
  const states = new WeakMap();
  const st = (win) => { let s = states.get(win); if (!s) { s = { g: null, route: null, over: null, click: null }; states.set(win, s); } return s; };

  const isFrame = (el) => el && (el.tagName === 'IFRAME' || el.tagName === 'FRAME');
  const shadow = (el) => { try { return (chrome.dom && chrome.dom.openOrClosedShadowRoot) ? chrome.dom.openOrClosedShadowRoot(el) : el.shadowRoot; } catch { return el.shadowRoot; } };
  function deepEl(doc, x, y) {
    let el = doc.elementFromPoint(x, y);
    for (let i = 0; el && i < 20; i++) {
      const sr = shadow(el);
      if (!sr || !sr.elementFromPoint) break;
      const inner = sr.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el || doc.documentElement;
  }
  const parentOf = (el) => el.parentElement || (el.parentNode && el.parentNode.host) || null;

  // 틀 안 좌표로 바꾸기(테두리·안쪽 여백·확대 반영)
  function into(ifr, x, y) {
    const r = ifr.getBoundingClientRect(), cs = getComputedStyle(ifr);
    const sx = ifr.offsetWidth ? r.width / ifr.offsetWidth : 1, sy = ifr.offsetHeight ? r.height / ifr.offsetHeight : 1;
    return {
      x: (x - r.left) / sx - ifr.clientLeft - parseFloat(cs.paddingLeft || 0),
      y: (y - r.top) / sy - ifr.clientTop - parseFloat(cs.paddingTop || 0),
    };
  }
  function sameOrigin(ifr) { try { return ifr.contentWindow && ifr.contentWindow.document ? ifr.contentWindow : null; } catch { return null; } }
  async function frameIdOf(ifr) {
    if (!ifr.contentWindow) return null;
    const nonce = crypto.randomUUID();
    ifr.contentWindow.postMessage({ __ebxq: nonce }, '*');
    for (let i = 0; i < 25; i++) {
      await sleep(i < 5 ? 8 : 20);
      const v = await chrome.runtime.sendMessage({ t: 'getfid', nonce }).catch(() => null);
      if (v != null) return v;
    }
    return null;
  }

  // 틀로 넘기기: 같은 출처면 여기서 바로, 다른 출처면 확장에게 그 틀 번호로 다시 보내 달라고 답함
  async function forward(win, ev, route) {
    const p = into(route.el, ev.x, ev.y);
    const e2 = { ...ev, x: p.x, y: p.y, abs: true };
    if (route.win) return run(e2, route.win);
    if (route.fid != null) return { fwd: route.fid, x: p.x, y: p.y };
    return {};
  }
  async function routeFor(el) {
    const w = sameOrigin(el);
    if (w) return { el, win: w };
    const fid = await frameIdOf(el);
    return fid != null ? { el, fid } : null;
  }

  // ── 가장 안쪽 문서까지 따라간 지금 초점 요소 ──
  function deepActive(doc) {
    let a = doc.activeElement;
    for (let i = 0; a && i < 20; i++) {
      const sr = shadow(a);
      if (sr && sr.activeElement) { a = sr.activeElement; continue; }
      if (isFrame(a)) { const w = sameOrigin(a); if (w && w.document.activeElement) { a = w.document.activeElement; continue; } }
      break;
    }
    return a;
  }
  const TEXT_TYPES = /^(text|search|email|url|tel|password|number|)$/i;
  const isText = (el) => el && ((el.tagName === 'INPUT' && TEXT_TYPES.test(el.type || '')) || el.tagName === 'TEXTAREA' || el.isContentEditable);
  function focusInfo(doc) {
    const a = deepActive(doc);
    if (a && a.tagName === 'SELECT') return { focus: 'select', idx: a.selectedIndex, opts: [...a.options].slice(0, 200).map((o) => o.text) };
    if (isText(a)) return { focus: 'text', pw: a.type === 'password', ph: a.getAttribute('placeholder') || a.getAttribute('aria-label') || '' };
    return { focus: null };
  }

  // ── 흉내 낸 사건 보내기 ──
  function mk(win, type, x, y, buttons, extra = {}) {
    const base = { bubbles: true, cancelable: true, composed: true, view: win, clientX: x, clientY: y, screenX: x, screenY: y, button: 0, buttons, detail: extra.detail || 0 };
    if (type.startsWith('pointer')) {
      return new win.PointerEvent(type, { ...base, pointerId: PID, pointerType: 'mouse', isPrimary: true, width: 1, height: 1, pressure: buttons ? 0.5 : 0 });
    }
    if (type === 'mouseenter' || type === 'mouseleave' || type === 'pointerenter' || type === 'pointerleave') base.bubbles = false;
    return new win.MouseEvent(type, base);
  }
  const fire = (el, ev) => el.dispatchEvent(ev);
  function hoverTo(win, s, el, x, y, buttons) {
    if (s.over === el) return;
    const prev = s.over;
    s.over = el;
    if (prev && prev.isConnected) { fire(prev, mk(win, 'pointerout', x, y, buttons)); fire(prev, mk(win, 'mouseout', x, y, buttons)); }
    fire(el, mk(win, 'pointerover', x, y, buttons)); fire(el, mk(win, 'mouseover', x, y, buttons));
    // enter: 새로 들어간 조상들에게만
    const chain = [];
    for (let n = el; n && n !== prev && !(prev && n.contains && n.contains(prev)); n = parentOf(n)) chain.push(n);
    for (const n of chain.reverse()) { n.dispatchEvent(mk(win, 'pointerenter', x, y, buttons)); n.dispatchEvent(mk(win, 'mouseenter', x, y, buttons)); }
  }
  function focusable(el) {
    for (let n = el; n; n = parentOf(n)) {
      if (n.nodeType !== 1) continue;
      if (n.isContentEditable || n.matches('input:not([disabled]),textarea:not([disabled]),select:not([disabled]),button:not([disabled]),a[href],[tabindex],summary,iframe')) return n;
    }
    return null;
  }
  function common(a, b) {
    if (!a || !b) return a || b;
    for (let n = a; n; n = parentOf(n)) if (n === b || (n.contains && n.contains(b))) return n;
    return a;
  }
  function scrollable(el, dx, dy) {
    for (let n = el; n; n = parentOf(n)) {
      if (n.nodeType !== 1) continue;
      const cs = getComputedStyle(n);
      const oy = /(auto|scroll|overlay)/.test(cs.overflowY) && n.scrollHeight > n.clientHeight + 1;
      const ox = /(auto|scroll|overlay)/.test(cs.overflowX) && n.scrollWidth > n.clientWidth + 1;
      if ((dy && oy) || (dx && ox)) {
        const canY = dy > 0 ? n.scrollTop + n.clientHeight < n.scrollHeight - 1 : n.scrollTop > 0;
        const canX = dx > 0 ? n.scrollLeft + n.clientWidth < n.scrollWidth - 1 : n.scrollLeft > 0;
        if ((dy && oy && canY) || (dx && ox && canX)) return n;
      }
    }
    return el.ownerDocument.scrollingElement || el.ownerDocument.documentElement;
  }
  function doScroll(el, dx, dy) { const n = scrollable(el, dx, dy); n.scrollBy({ left: dx, top: dy, behavior: 'instant' }); }

  // 끌어서 놓기(draggable): 흉내 낸 마우스로는 브라우저가 끌기를 시작하지 않으므로 drag 사건을 직접 보냄
  function dragEv(win, type, x, y, dt) {
    return new win.DragEvent(type, { bubbles: true, cancelable: type !== 'dragleave' && type !== 'dragend', composed: true, view: win, clientX: x, clientY: y, screenX: x, screenY: y, dataTransfer: dt });
  }

  const mark = (doc) => doc.documentElement && doc.documentElement.setAttribute('data-ebx-g', String(Date.now()));

  // ── 한 문서에서 처리 ──
  async function run(ev, win) {
    const doc = win.document, s = st(win);
    let x = ev.x, y = ev.y;
    if (!ev.abs) {                      // 칠판은 0~1 비율로 보냄 → 이 탭 화면 크기로
      x = ev.nx * win.innerWidth; y = ev.ny * win.innerHeight;
      ev = { ...ev, x, y, abs: true };
      if (ev.k === 'wheel') ev = { ...ev, dx: ev.ndx * win.innerWidth, dy: ev.ndy * win.innerHeight };
    }
    const k = ev.k;
    if (k !== 'size' && k !== 'hover') mark(doc);

    if (k === 'text' || k === 'key' || k === 'select') return typing(ev, win);
    if (k === 'back') { if (TOP) history.back(); return {}; }
    if (k === 'size') return { w: win.innerWidth, h: win.innerHeight };

    // 누르는 중에는 처음 누른 틀로 계속(틀 밖으로 끌어도)
    if (k !== 'down' && k !== 'hover' && k !== 'wheel' && s.route) {
      const r = s.route;
      if (k === 'up' || k === 'cancel') s.route = null;
      return forward(win, ev, r);
    }
    const el = deepEl(doc, x, y);
    if (isFrame(el) && (k === 'down' || k === 'hover' || k === 'wheel') && !(s.g && k !== 'down')) {
      const r = await routeFor(el);
      if (r) {
        if (k === 'down') { s.route = r; s.g = null; if (s.over) hoverTo(win, s, el, x, y, 0); }
        return forward(win, ev, r);
      }
    }

    if (k === 'hover') {
      hoverTo(win, s, el, x, y, 0);
      fire(el, mk(win, 'pointermove', x, y, 0)); fire(el, mk(win, 'mousemove', x, y, 0));
      return {};
    }
    if (k === 'wheel') {
      const ok = fire(el, new win.WheelEvent('wheel', { bubbles: true, cancelable: true, composed: true, view: win, clientX: x, clientY: y, deltaX: ev.dx, deltaY: ev.dy, deltaMode: 0 }));
      if (ok) doScroll(el, ev.dx, ev.dy);
      return {};
    }
    if (k === 'down') {
      hoverTo(win, s, el, x, y, 0);
      doc.querySelectorAll('[data-ebx-cap]').forEach((e) => e.removeAttribute('data-ebx-cap'));
      const pd = fire(el, mk(win, 'pointerdown', x, y, 1));
      const md = pd ? fire(el, mk(win, 'mousedown', x, y, 1)) : false;
      if (md) {
        const f = focusable(el);
        const a = deepActive(doc);
        if (f && f !== a) { try { f.focus({ preventScroll: true }); } catch { /* 초점 안 됨 */ } }
        else if (!f && a && a !== doc.body && a.blur) a.blur();
      }
      const drag = el.closest && el.closest('[draggable="true"]');
      s.g = { el, x0: x, y0: y, lx: x, ly: y, moved: false, compat: pd, prevented: !pd || !md, touch: !!ev.touch, drag, dt: null, dragOver: null, t0: Date.now() };
      return {};
    }
    const g = s.g;
    if (!g) return {};
    const cap = doc.querySelector('[data-ebx-cap]');
    if (k === 'move') {
      if (!g.moved && Math.hypot(x - g.x0, y - g.y0) > 6) g.moved = true;
      const tgt = cap || el;
      hoverTo(win, s, tgt, x, y, 1);
      fire(tgt, mk(win, 'pointermove', x, y, 1));
      if (g.compat) fire(tgt, mk(win, 'mousemove', x, y, 1));
      if (g.moved && g.drag) {
        if (!g.dt) {
          g.dt = new win.DataTransfer();
          g.dt.effectAllowed = 'all';
          if (!fire(g.drag, dragEv(win, 'dragstart', x, y, g.dt))) g.drag = null;
        }
        if (g.drag) {
          if (g.dragOver !== el) { if (g.dragOver) fire(g.dragOver, dragEv(win, 'dragleave', x, y, g.dt)); fire(el, dragEv(win, 'dragenter', x, y, g.dt)); g.dragOver = el; }
          g.dropOk = !fire(el, dragEv(win, 'dragover', x, y, g.dt));     // dragover 를 막아야 놓을 수 있는 곳
          fire(g.drag, dragEv(win, 'drag', x, y, g.dt));
        }
      } else if (g.moved && g.touch && !g.prevented && !cap) {
        doScroll(g.el, g.lx - x, g.ly - y);                                // 손가락으로 끌면 화면이 따라 올라감(터치 스크롤처럼)
      }
      g.lx = x; g.ly = y;
      return {};
    }
    if (k === 'cancel') {
      fire(cap || el, mk(win, 'pointercancel', x, y, 0));
      if (g.dt && g.drag) fire(g.drag, dragEv(win, 'dragend', x, y, g.dt));
      s.g = null; if (cap) cap.removeAttribute('data-ebx-cap');
      return {};
    }
    if (k === 'up') {
      const tgt = cap || el;
      if (g.dt && g.drag) {
        if (g.dragOver && g.dropOk) fire(g.dragOver, dragEv(win, 'drop', x, y, g.dt));
        fire(g.drag, dragEv(win, 'dragend', x, y, g.dt));
      }
      fire(tgt, mk(win, 'pointerup', x, y, 0));
      if (g.compat) fire(tgt, mk(win, 'mouseup', x, y, 0));
      if (cap) cap.removeAttribute('data-ebx-cap');
      s.g = null;
      if (!g.moved || (!g.touch && !g.dt)) {
        const c = g.moved ? common(g.el, tgt) : g.el;
        const now = Date.now();
        const dbl = s.click && now - s.click.t < 450 && Math.hypot(x - s.click.x, y - s.click.y) < 20;
        const n = dbl ? s.click.n + 1 : 1;
        s.click = { t: now, x, y, n };
        click(win, c, x, y, n);
        if (n === 2) fire(c, mk(win, 'dblclick', x, y, 0, { detail: 2 }));
      }
      return focusInfo(doc);
    }
    return {};
  }

  // 누르기: 새 창으로 여는 링크는 같은 탭에서 열어 칠판에 그대로 보이게(직접 누른 것이 아니라 새 창은 막힘)
  function click(win, el, x, y, n) {
    const a = el.closest && el.closest('a[href]');
    const tgt = a && (a.getAttribute('target') || '').toLowerCase();
    const newWin = a && tgt && !['_self', '_top', '_parent'].includes(tgt);
    if (newWin && TOP) {
      a.setAttribute('target', '_self');
      try { fire(el, mk(win, 'click', x, y, 0, { detail: n })); } finally { a.setAttribute('target', tgt); }
      return;
    }
    const ok = fire(el, mk(win, 'click', x, y, 0, { detail: n }));
    if (newWin && ok && /^https?:/.test(a.href)) chrome.runtime.sendMessage({ t: 'nav', url: a.href }).catch(() => {});
  }

  // ── 글자 넣기·특수 키·고르기 칸 ──
  function key(win, el, type, k) {
    const codes = { Enter: 13, Backspace: 8, Tab: 9, Escape: 27, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, ' ': 32, PageUp: 33, PageDown: 34, Home: 36, End: 35, Delete: 46 };
    const kc = codes[k] || 0;
    const code = k === ' ' ? 'Space' : k;
    return el.dispatchEvent(new win.KeyboardEvent(type, { key: k, code, keyCode: kc, which: kc, bubbles: true, cancelable: true, composed: true, view: win }));
  }
  function typing(ev, win) {
    const doc = win.document;
    mark(doc);
    const a = deepActive(doc) || doc.body;
    const ad = a.ownerDocument || doc, aw = ad.defaultView || win;
    if (ev.k === 'select') {
      if (a.tagName === 'SELECT' && ev.i >= 0 && ev.i < a.options.length) {
        a.selectedIndex = ev.i;
        a.dispatchEvent(new aw.Event('input', { bubbles: true })); a.dispatchEvent(new aw.Event('change', { bubbles: true }));
      }
      return focusInfo(doc);
    }
    if (ev.k === 'text') {
      const s = String(ev.s || '');
      if (!s) return {};
      if (isText(a)) {
        let done = false;
        try { done = ad.execCommand('insertText', false, s); } catch { done = false; }
        if (!done && a.tagName !== 'DIV' && 'value' in a) {
          const proto = a.tagName === 'TEXTAREA' ? aw.HTMLTextAreaElement.prototype : aw.HTMLInputElement.prototype;
          const set = Object.getOwnPropertyDescriptor(proto, 'value').set;
          let s0 = a.value.length, s1 = s0;
          try { if (a.selectionStart != null) { s0 = a.selectionStart; s1 = a.selectionEnd; } } catch { /* number 등 */ }
          set.call(a, a.value.slice(0, s0) + s + a.value.slice(s1));
          try { a.setSelectionRange(s0 + s.length, s0 + s.length); } catch { /* 지원 안 함 */ }
          a.dispatchEvent(new aw.InputEvent('input', { bubbles: true, inputType: 'insertText', data: s }));
        }
      }
      return focusInfo(doc);
    }
    // 특수 키
    const k = ev.key;
    if (k === 'Escape') { ad.dispatchEvent(new aw.CustomEvent('__ebx_fs_exit')); if (ad !== document) document.dispatchEvent(new CustomEvent('__ebx_fs_exit')); }
    const ok = key(aw, a, 'keydown', k);
    if (ok) {
      if (k === 'Enter') key(aw, a, 'keypress', k);
      if (ok && isText(a)) {
        if (k === 'Backspace') ad.execCommand('delete', false);
        else if (k === 'Delete') ad.execCommand('forwardDelete', false);
        else if (k === 'Enter') {
          if (a.tagName === 'INPUT') { const f = a.form; if (f) { try { f.requestSubmit(); } catch { f.submit(); } } }
          else ad.execCommand(a.isContentEditable ? 'insertParagraph' : 'insertLineBreak', false);
        }
      } else if (k === 'Enter' || k === ' ') {
        if (a !== ad.body && a.matches && a.matches('button,a[href],[role="button"],input[type="checkbox"],input[type="radio"],input[type="submit"],summary')) a.click();
      } else if (/^(ArrowUp|ArrowDown|PageUp|PageDown|Home|End| )$/.test(k)) {
        const h = aw.innerHeight;
        const dy = { ArrowUp: -60, ArrowDown: 60, PageUp: -h * 0.85, PageDown: h * 0.85, ' ': h * 0.85, Home: -1e7, End: 1e7 }[k];
        doScroll(a === ad.body ? ad.documentElement : a, 0, dy);
      }
    }
    key(aw, a, 'keyup', k);
    return focusInfo(doc);
  }
})();
