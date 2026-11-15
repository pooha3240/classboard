// 기본판 자료 변환: 서버 대신 이 기기의 브라우저가 사진을 줄이고 PDF 를 쪽 그림으로 바꿉니다.
// 결과는 webp(지원 안 하는 브라우저는 jpg) 본 그림 + 작은 미리보기 그림입니다.
const PDFJS = '/vendor/pdfjs/';
const MAX_SIDE = 2400;          // 사진: 긴 쪽 최대
const PDF_WIDTH = 2000;         // PDF 쪽: 가로 픽셀
const MAX_H = 9000;             // 아주 긴 쪽은 이 높이까지
const THUMB_W = 320;
const MAX_BYTES = 7.5 * 1024 * 1024;

export async function sha256Hex(buf) {
  const h = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const toBlob = (c, type, q) => new Promise((r) => c.toBlob(r, type, q));

async function encode(canvas, q = 0.85) {
  let b = await toBlob(canvas, 'image/webp', q);
  if (!b || b.type !== 'image/webp') b = await toBlob(canvas, 'image/jpeg', q + 0.03);   // 사파리 등: webp 저장 못 함
  for (let qq = q - 0.15; b && b.size > MAX_BYTES && qq > 0.3; qq -= 0.15) b = await toBlob(canvas, b.type, qq);
  if (!b) throw new Error('그림을 만들지 못했습니다');
  return b;
}

async function thumbOf(canvas) {
  const k = Math.min(1, THUMB_W / canvas.width);
  const t = document.createElement('canvas');
  t.width = Math.max(1, Math.round(canvas.width * k)); t.height = Math.max(1, Math.round(canvas.height * k));
  const g = t.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, t.width, t.height);
  g.drawImage(canvas, 0, 0, t.width, t.height);
  const b = await encode(t, 0.75);
  t.width = t.height = 0;
  return b;
}

/** 사진 한 장 → { blob, thumb, w, h } */
export async function convertImage(file) {
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch {
    try { bmp = await createImageBitmap(file); } catch {
      const heic = /\.(heic|heif)$/i.test(file.name || '') || /hei[cf]/.test(file.type || '');
      throw new Error(heic
        ? 'HEIC 사진은 이 기기에서 열 수 없습니다. 아이폰 설정 → 카메라 → 포맷 → 높은 호환성으로 바꾸거나 JPG로 저장해 주세요'
        : '사진을 열 수 없습니다. JPG·PNG 로 저장해서 올려 주세요');
    }
  }
  const k = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bmp.width * k)); c.height = Math.max(1, Math.round(bmp.height * k));
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);       // 투명 PNG 는 흰 바탕으로
  g.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close && bmp.close();
  const out = { blob: await encode(c), thumb: await thumbOf(c), w: c.width, h: c.height };
  c.width = c.height = 0;
  return out;
}

let pdfjsP = null;
async function pdfjs() {
  if (!pdfjsP) {
    pdfjsP = import(PDFJS + 'pdf.min.mjs').then((m) => { m.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.mjs'; return m; });
    pdfjsP.catch(() => { pdfjsP = null; });
  }
  return pdfjsP;
}

/** PDF 열기 → { pages, page(i) => Promise<{blob, thumb, w, h}>, close() } */
export async function openPdf(buf) {
  const lib = await pdfjs();
  let doc;
  const task = lib.getDocument({
      data: new Uint8Array(buf), cMapUrl: PDFJS + 'cmaps/', cMapPacked: true,
      standardFontDataUrl: PDFJS + 'standard_fonts/', wasmUrl: PDFJS + 'wasm/', iccUrl: PDFJS + 'iccs/',
      isEvalSupported: false, enableXfa: false,
  });
  try {
    doc = await task.promise;
  } catch (e) {
    task.destroy();
    if (e && e.name === 'PasswordException') throw new Error('암호가 걸린 PDF 입니다. 암호를 푼 PDF 로 저장해 올려 주세요');
    throw new Error('PDF 를 열 수 없습니다 (손상된 파일일 수 있습니다)');
  }
  return {
    pages: doc.numPages,
    async page(i) {
      const p = await doc.getPage(i + 1);
      const v1 = p.getViewport({ scale: 1 });
      const scale = Math.min(PDF_WIDTH / v1.width, MAX_H / v1.height);
      const vp = p.getViewport({ scale });
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(vp.width)); c.height = Math.max(1, Math.round(vp.height));
      const g = c.getContext('2d');
      g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
      await p.render({ canvasContext: g, canvas: c, viewport: vp, background: '#ffffff' }).promise;
      p.cleanup();
      const out = { blob: await encode(c), thumb: await thumbOf(c), w: c.width, h: c.height };
      c.width = c.height = 0;
      return out;
    },
    close() { try { task.destroy(); } catch { /* 무시 */ } },
  };
}
