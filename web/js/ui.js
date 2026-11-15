// 화면 안 확인·입력 창: 브라우저 기본 창(confirm·prompt)은 전체 화면을 풀어 버리므로 쓰지 않습니다.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function open({ message, ok = '확인', cancel = '취소', danger = false, input = null }) {
  return new Promise((resolve) => {
    const el = document.createElement('div');
    el.className = 'ct-overlay ui-dialog';
    el.innerHTML = `
      <div class="ct-card ui-card" role="dialog" aria-modal="true">
        <p class="ui-msg">${esc(message)}</p>
        ${input !== null ? `<input type="text" class="ui-input" value="${esc(input)}" maxlength="60">` : ''}
        <div class="ui-actions">
          <button type="button" class="chip" data-a="no">${esc(cancel)}</button>
          <button type="button" class="ct-big ${danger ? 'danger' : ''}" data-a="ok">${esc(ok)}</button>
        </div>
      </div>`;
    // 열린 모달(dialog)이 있으면 그 안에 넣어야 위에 보입니다(모달은 최상위 층)
    const host = [...document.querySelectorAll('dialog[open]')].pop() || document.body;
    host.appendChild(el);
    const inp = el.querySelector('.ui-input');
    const done = (v) => { el.remove(); document.removeEventListener('keydown', key, true); resolve(v); };
    const yes = () => done(input !== null ? inp.value.trim() || null : true);
    const no = () => done(input !== null ? null : false);
    const key = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); no(); }
      else if (e.key === 'Enter') { e.preventDefault(); yes(); }
    };
    document.addEventListener('keydown', key, true);
    el.addEventListener('pointerdown', (e) => { if (e.target === el) no(); });
    el.querySelector('[data-a="ok"]').onclick = yes;
    el.querySelector('[data-a="no"]').onclick = no;
    (inp || el.querySelector('[data-a="ok"]')).focus();
    if (inp) inp.select();
  });
}

export const askConfirm = (message, ok = '확인', opts = {}) => open({ message, ok, ...opts });
export const askText = (message, value = '', ok = '저장') => open({ message, ok, input: value });
