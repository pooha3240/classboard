/**
 * 전자칠판 도우미(크롬 확장) 내려받기: GET /helper.zip
 * 확장 원본(web/helper/ext/)에 이 칠판의 주소를 채워 zip 으로 묶어 줍니다.
 * 칠판마다 주소가 달라(classboard.<이름>.workers.dev 등) 받은 칠판에서만 조작을 보낼 수 있게 합니다.
 */
const FILES = ["manifest.json", "bg.js", "page.js", "main.js", "bridge.js", "icon48.png", "icon128.png"];
const DIR = "classboard-helper/";

let crcTable: Uint32Array | null = null;
function crc32(b: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 압축하지 않은(stored) zip. 파일이 작아(30KB 남짓) 충분합니다. */
export function makeZip(files: { name: string; data: Uint8Array }[]): Uint8Array {
  const enc = new TextEncoder();
  const DOS_TIME = 0, DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;
  const locals: Uint8Array[] = [], centrals: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name), crc = crc32(f.data), size = f.data.length;
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
    lh.setUint16(10, DOS_TIME, true); lh.setUint16(12, DOS_DATE, true); lh.setUint32(14, crc, true);
    lh.setUint32(18, size, true); lh.setUint32(22, size, true); lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
    const local = new Uint8Array(30 + name.length + size);
    local.set(new Uint8Array(lh.buffer), 0); local.set(name, 30); local.set(f.data, 30 + name.length);
    locals.push(local);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 0x0314, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
    ch.setUint16(10, 0, true); ch.setUint16(12, DOS_TIME, true); ch.setUint16(14, DOS_DATE, true); ch.setUint32(16, crc, true);
    ch.setUint32(20, size, true); ch.setUint32(24, size, true); ch.setUint16(28, name.length, true);
    ch.setUint32(38, (0o100644 << 16) >>> 0, true); ch.setUint32(42, offset, true);
    const central = new Uint8Array(46 + name.length);
    central.set(new Uint8Array(ch.buffer), 0); central.set(name, 46);
    centrals.push(central);
    offset += local.length;
  }
  const cdSize = centrals.reduce((a, c) => a + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  const out = new Uint8Array(offset + cdSize + 22);
  let p = 0;
  for (const part of [...locals, ...centrals, new Uint8Array(end.buffer)]) { out.set(part, p); p += part.length; }
  return out;
}

export async function helperZip(req: Request, assets: Fetcher): Promise<Response> {
  const url = new URL(req.url);
  if (!/^[a-z0-9.-]+$/i.test(url.hostname)) return new Response("bad host", { status: 400 });
  const origin = url.origin, match = `${url.protocol}//${url.hostname}/*`;   // 크롬 주소 규칙은 포트를 적지 않으면 모든 포트
  const files: { name: string; data: Uint8Array }[] = [];
  for (const f of FILES) {
    const r = await assets.fetch(new Request(new URL("/helper/ext/" + f, url)));
    if (!r.ok) return new Response("helper file missing: " + f, { status: 500 });
    let data: Uint8Array = new Uint8Array(await r.arrayBuffer());
    if (f === "manifest.json" || f === "bg.js") {
      const text = new TextDecoder().decode(data).replaceAll("__BOARD_ORIGIN__", origin).replaceAll("__BOARD_MATCH__", match);
      data = new TextEncoder().encode(text);
    }
    files.push({ name: DIR + f, data });
  }
  return new Response(makeZip(files), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": 'attachment; filename="classboard-helper.zip"',
      "Cache-Control": "no-store",
    },
  });
}
