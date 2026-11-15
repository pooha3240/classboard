// 전자칠판용 PIN 입력 (큰 숫자 버튼)
const DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '지움', '0', '확인'];

export function askPin(title = 'PIN 입력', hint = '') {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'pin-dialog';
    dlg.innerHTML = `
      <h2>${title}</h2>
      <p class="muted pin-hint">${hint}</p>
      <div class="pin-dots" aria-live="polite"></div>
      <div class="pin-pad">${DIGITS.map((d) => `<button type="button" data-k="${d}">${d}</button>`).join('')}</div>
      <button type="button" class="pin-cancel">취소</button>`;
    document.body.appendChild(dlg);
    let pin = '';
    const dots = dlg.querySelector('.pin-dots');
    const draw = () => { dots.textContent = pin ? '●'.repeat(pin.length) : '·'; };
    const done = (v) => { dlg.close(); dlg.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
    const press = (k) => {
      if (k === '지움') pin = pin.slice(0, -1);
      else if (k === '확인') { if (pin.length >= 4) done(pin); return; }
      else if (/^\d$/.test(k) && pin.length < 6) pin += k;
      draw();
    };
    const onKey = (e) => {
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === 'Backspace') press('지움');
      else if (e.key === 'Enter') press('확인');
    };
    dlg.querySelector('.pin-pad').addEventListener('click', (e) => { const k = e.target.dataset.k; if (k) press(k); });
    dlg.querySelector('.pin-cancel').addEventListener('click', () => done(null));
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); done(null); });
    document.addEventListener('keydown', onKey);
    draw();
    dlg.showModal();
  });
}
