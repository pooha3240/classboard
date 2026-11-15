// 기록·설정 화면 공용: 토큰 얻기와 API 호출
// PIN 으로 받은 전자칠판 토큰(sessionStorage) → 교사 로그인 토큰(이 기기에 저장된 것) 순서로 씁니다.
import { savedToken } from './net.js';

export async function getToken() {
  try {
    const e = JSON.parse(sessionStorage.getItem('eboard.elev') || 'null');
    if (e && e.exp * 1000 > Date.now() + 5000) return e.token;
  } catch { /* 없음 */ }
  const t = savedToken('teacher');
  if (t) return t.token;
  const err = new Error('로그인이 필요합니다');
  err.code = 'login';
  throw err;
}

export async function api(path, opts = {}) {
  const t = await getToken();
  const r = await fetch('/eboard-api' + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t, ...(opts.headers || {}) },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error((j.detail && j.detail.message) || ('HTTP ' + r.status));
    e.code = j.detail && j.detail.error;
    throw e;
  }
  return j;
}

export function needLogin(e) {
  if (e.code !== 'login' && e.code !== 'pin_required') return false;
  const hasDevice = !!JSON.parse(localStorage.getItem('eboard.deviceKey') || 'null');
  document.body.innerHTML = `<main class="notice"><h1>${hasDevice ? 'PIN 이 필요합니다' : '로그인이 필요합니다'}</h1>
    <p>${hasDevice ? '칠판 화면의 메뉴에서 다시 열어 PIN 을 입력하세요.' : '교사 계정으로 로그인한 뒤 다시 여세요.'}</p>
    <p><a class="chip" href="${hasDevice ? './' : document.body.dataset.login}">${hasDevice ? '칠판으로' : '로그인'}</a></p></main>`;
  return true;
}

export const $ = (s, el = document) => el.querySelector(s);
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
