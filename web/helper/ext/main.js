// 페이지 안(MAIN)에서 도는 부분: 흉내 낸 누르기로는 막히는 것들을 대신 처리
//  - setPointerCapture: 흉내 낸 포인터(번호 9999)는 진짜 포인터가 아니라 오류가 나므로 받아 주고 기억
//  - window.open: 사용자가 직접 누른 것이 아니라 팝업이 막힘 → 같은 탭에서 열어 칠판에 그대로 보이게
//  - 전체 화면: 직접 누른 것이 아니라 거절됨 → 그 요소를 탭 화면 가득 채워 보여 줌
(() => {
  if (window.__ebxMain) return;
  window.__ebxMain = true;
  const ID = 9999;
  const root = () => document.documentElement;
  const fresh = () => +(root() && root().getAttribute('data-ebx-g') || 0) > Date.now() - 1500;
  const EP = Element.prototype;

  const sp = EP.setPointerCapture, rp = EP.releasePointerCapture, hp = EP.hasPointerCapture;
  EP.setPointerCapture = function (id) {
    if (id !== ID) return sp.call(this, id);
    document.querySelectorAll('[data-ebx-cap]').forEach((e) => e.removeAttribute('data-ebx-cap'));
    this.setAttribute('data-ebx-cap', '');
  };
  EP.releasePointerCapture = function (id) { if (id !== ID) return rp.call(this, id); this.removeAttribute('data-ebx-cap'); };
  EP.hasPointerCapture = function (id) { return id === ID ? this.hasAttribute('data-ebx-cap') : hp.call(this, id); };

  const wo = window.open;
  window.open = function (url, name, feat) {
    if (fresh() && url) {
      let u = null;
      try { u = new URL(url, location.href); } catch { /* 주소 아님 */ }
      if (u && /^https?:$/.test(u.protocol)) {
        document.dispatchEvent(new CustomEvent('__ebx_open', { detail: u.href }));
        const noop = () => {};
        return { closed: false, focus: noop, blur: noop, close: noop, postMessage: noop, opener: window, location: { href: u.href } };
      }
    }
    return wo.apply(this, arguments);
  };

  // ── 전체 화면 흉내 ──
  let fs = null;
  const css = () => {
    if (document.getElementById('__ebx_fs_css')) return;
    const st = document.createElement('style');
    st.id = '__ebx_fs_css';
    st.textContent = '[data-ebx-fs]{position:fixed!important;left:0!important;top:0!important;right:0!important;bottom:0!important;width:100vw!important;height:100vh!important;max-width:none!important;max-height:none!important;margin:0!important;transform:none!important;z-index:2147483647!important;background:#000}video[data-ebx-fs]{object-fit:contain!important}';
    (document.head || root()).appendChild(st);
  };
  const fire = () => {
    document.dispatchEvent(new Event('fullscreenchange', { bubbles: true })); document.dispatchEvent(new Event('webkitfullscreenchange', { bubbles: true }));
    document.dispatchEvent(new CustomEvent('__ebx_fs_state', { detail: fs ? 'on' : 'off' }));   // 틀 안이면 바깥 문서도 이 틀을 화면 가득
  };
  const enter = (el) => { css(); if (fs) fs.removeAttribute('data-ebx-fs'); fs = el; el.setAttribute('data-ebx-fs', ''); fire(); };
  const leave = () => { if (!fs) return false; fs.removeAttribute('data-ebx-fs'); fs = null; fire(); return true; };
  for (const name of ['requestFullscreen', 'webkitRequestFullscreen', 'webkitRequestFullScreen']) {
    const orig = EP[name];
    if (!orig) continue;
    EP[name] = function () {
      if (!fresh()) return orig.apply(this, arguments);
      let p;
      try { p = orig.apply(this, arguments); } catch { p = Promise.reject(); }
      const el = this;
      return Promise.resolve(p).catch(() => enter(el));
    };
  }
  const DP = Document.prototype;
  for (const name of ['exitFullscreen', 'webkitExitFullscreen', 'webkitCancelFullScreen']) {
    const orig = DP[name];
    if (!orig) continue;
    DP[name] = function () { if (leave()) return Promise.resolve(); return orig.apply(this, arguments); };
  }
  for (const name of ['fullscreenElement', 'webkitFullscreenElement', 'webkitCurrentFullScreenElement']) {
    const d = Object.getOwnPropertyDescriptor(DP, name);
    if (!d || !d.get) continue;
    Object.defineProperty(DP, name, { configurable: true, enumerable: d.enumerable, get() { return fs && this === document ? fs : d.get.call(this); } });
  }
  for (const name of ['fullscreen', 'webkitIsFullScreen']) {
    const d = Object.getOwnPropertyDescriptor(DP, name);
    if (!d || !d.get) continue;
    Object.defineProperty(DP, name, { configurable: true, enumerable: d.enumerable, get() { return (fs && this === document) || d.get.call(this); } });
  }
  document.addEventListener('__ebx_fs_exit', leave);
})();
