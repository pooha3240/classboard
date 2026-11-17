// 이 기기의 동영상 파일: 서버에 올리지 않고, 영상을 트는 기기가 자기 파일을 직접 재생합니다(모든 판).
// 서버에는 파일 이름·크기·길이·작은 미리보기 그림만 갑니다. 재생·멈춤·위치는 지금처럼 서버가 알려 줍니다.
// 같은 파일인지는 '이름 + 크기'로 봅니다. 크롬 PC 는 파일 위치(handle)를 이 기기에 기억해 두어,
// 새로 고침이나 다음 수업에도 권한 허락 한 번이면 다시 열립니다(다른 브라우저는 이번 화면에서만 기억).

const DB = 'classboard-localvideo', STORE = 'handles';
const mem = new Map();                    // key → File (이번 화면 동안)
export const VIDEO_ACCEPT = 'video/mp4,video/webm,video/quicktime,.mp4,.m4v,.mov,.webm';
export const isVideoFile = (f) => !!f && (/^video\//.test(f.type || '') || /\.(mp4|m4v|mov|webm)$/i.test(f.name || ''));
export const localKey = (name, size) => `${String(name || '')}|${Number(size) || 0}`;

function db() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) { reject(new Error('no_idb')); return; }
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idb(mode, fn) {
  const d = await db();
  try {
    return await new Promise((resolve, reject) => {
      const tx = d.transaction(STORE, mode), req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = () => reject(tx.error);
    });
  } finally { d.close(); }
}

/** 고른 파일을 이 기기에 기억(handle 이 있으면 다음에도) */
export async function remember(file, handle = null, key = localKey(file.name, file.size)) {
  mem.set(key, file);
  if (handle) { try { await idb('readwrite', (s) => s.put(handle, key)); } catch { /* 기억 못 해도 이번 화면에서는 재생됨 */ } }
  return key;
}

/**
 * 이 기기에서 그 파일 찾기.
 * → {file} | {needsPermission: handle} (사용자가 버튼을 눌러 허락해야 함) | null(없음)
 */
export async function findLocal(key) {
  if (mem.has(key)) return { file: mem.get(key) };
  let h = null;
  try { h = await idb('readonly', (s) => s.get(key)); } catch { return null; }
  if (!h || typeof h.getFile !== 'function') return null;
  try {
    const p = h.queryPermission ? await h.queryPermission({ mode: 'read' }) : 'granted';
    if (p === 'granted') return fromHandle(key, h);
    if (p === 'prompt') return { needsPermission: h };
  } catch { /* 아래 */ }
  return null;
}

/** 허락 받기(버튼을 누른 직후에만 부를 것) */
export async function grant(key, h) {
  try {
    if (h.requestPermission && (await h.requestPermission({ mode: 'read' })) !== 'granted') return null;
    return fromHandle(key, h);
  } catch { return null; }
}

async function fromHandle(key, h) {
  try {
    const f = await h.getFile();
    if (localKey(f.name, f.size) !== key) return null;          // 파일이 바뀌었거나 옮겨짐
    mem.set(key, f);
    return { file: f };
  } catch { return null; }                                       // 지워졌거나 옮겨짐
}

/** 파일 고르기 창: 크롬 PC 는 위치를 기억할 수 있게 showOpenFilePicker, 아니면 일반 파일 창 */
export async function pickFile(accept = VIDEO_ACCEPT, videoOnly = true) {
  if (window.showOpenFilePicker && window.isSecureContext) {
    try {
      const types = videoOnly
        ? [{ description: '동영상', accept: { 'video/*': ['.mp4', '.m4v', '.mov', '.webm'] } }]
        : [{ description: '사진·PDF·동영상', accept: { 'image/*': ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.heic', '.heif', '.bmp'], 'application/pdf': ['.pdf'], 'video/*': ['.mp4', '.m4v', '.mov', '.webm'] } }];
      const [h] = await window.showOpenFilePicker({ types, excludeAcceptAllOption: false, multiple: false, id: 'classboard-media' });
      const file = await h.getFile();
      return { file, handle: h };
    } catch (e) {
      if (e && e.name === 'AbortError') return null;            // 사용자가 닫음
      /* 막혔으면 일반 파일 창으로 */
    }
  }
  return new Promise((resolve) => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = accept; inp.hidden = true;
    inp.onchange = () => { const f = inp.files[0]; inp.remove(); resolve(f ? { file: f, handle: null } : null); };
    inp.addEventListener('cancel', () => { inp.remove(); resolve(null); });
    document.body.appendChild(inp);
    inp.click();
  });
}

/** 끌어다 놓은 파일의 위치(handle) 얻기(크롬). 꼭 drop 이벤트 안에서 바로 부를 것 */
export function dropHandle(e) {
  const it = e.dataTransfer && [...e.dataTransfer.items].find((x) => x.kind === 'file');
  return it && it.getAsFileSystemHandle ? it.getAsFileSystemHandle().catch(() => null) : Promise.resolve(null);
}

/** 이 기기에서 열어 보고 서버에 보낼 정보 만들기: {src:'local', name, size, dur, w, h, thumb} */
export function describe(file) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    const url = URL.createObjectURL(file);
    let done = false;
    const meta = (extra) => ({ src: 'local', name: String(file.name || '동영상').slice(0, 200), size: file.size, ...extra });
    const dur = () => (Number.isFinite(v.duration) ? Math.min(v.duration, 86400) : 0);
    const finish = (r) => { if (done) return; done = true; URL.revokeObjectURL(url); v.removeAttribute('src'); v.load(); resolve(r); };
    v.muted = true; v.playsInline = true; v.preload = 'auto';
    v.onerror = () => finish(null);
    v.onloadedmetadata = () => {
      if (!v.videoWidth) { finish(meta({ dur: dur(), w: 0, h: 0, thumb: null })); return; }   // 소리만 있는 파일
      v.currentTime = Math.min(1, (v.duration || 2) / 3);
    };
    v.onseeked = () => {
      const c = document.createElement('canvas'), k = Math.min(1, 320 / v.videoWidth);
      c.width = Math.round(v.videoWidth * k); c.height = Math.round(v.videoHeight * k);
      let thumb = null;
      try {
        c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
        thumb = c.toDataURL('image/webp', 0.6);
        if (!thumb.startsWith('data:image/webp')) thumb = c.toDataURL('image/jpeg', 0.6);
        if (thumb.length > 60000) thumb = null;
      } catch { thumb = null; }
      finish(meta({ dur: dur(), w: v.videoWidth, h: v.videoHeight, thumb }));
    };
    setTimeout(() => finish(null), 15000);
    v.src = url;
  });
}
