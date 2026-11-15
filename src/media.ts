/**
 * 기본판 자료 저장: 사진·PDF 쪽을 Durable Object 의 SQLite 에 그림으로 보관합니다(R2 없음).
 *
 * - 변환(사진 줄이기, PDF → 쪽 그림)은 올리는 기기의 브라우저가 합니다. 서버는 받은 그림을 그대로 보관만.
 * - 한 칸(BLOB)은 2MB 까지라 큰 그림은 조각으로 나눠 저장합니다.
 * - 무료 플랜의 객체당 1GB 안에서 판서 기록과 함께 쓰므로, 자료는 MEDIA_QUOTA 까지만 두고
 *   넘치면 오래 안 쓴 자료부터 지웁니다.
 * - 파일 주소에는 자료마다 무작위 키가 들어가 있어, 로그인 없이 <img> 로 바로 불러옵니다(주소를 아는 사람만).
 */
import { randomKey } from "./lib/token";

export const MEDIA_QUOTA = 700 * 1000 * 1000;     // 700MB
export const MAX_PDF_PAGES = 60;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;    // 한 장(쪽) 그림
export const MAX_THUMB_BYTES = 256 * 1024;
const PART = 1_900_000;                            // BLOB 조각 크기(한도 2MB 아래)
const KINDS = new Set(["image", "pdf", "capture"]);

export type Asset = {
  id: number; key: string; kind: string; set_id: number; page_index: number | null; pages: number;
  name: string | null; sha: string | null; mime: string; thumb_mime: string | null;
  w: number; h: number; bytes: number; created_at: number; used_at: number; done: number;
};

export class MediaError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

export function sniffImage(b: Uint8Array): string | null {
  if (b.length < 12) return null;
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  return null;
}

export function fileUrl(a: { id: number; key: string }, thumb = false): string {
  return `/eboard-api/files/${a.id}?k=${a.key}${thumb ? "&t=1" : ""}`;
}

export function item(a: Asset) {
  return { asset: a.id, w: a.w, h: a.h, page: a.page_index, url: fileUrl(a), thumb: fileUrl(a, a.thumb_mime !== null) };
}

/** 자료 비율에 맞춘 페이지 크기: 너비 3200 고정, 세로로 긴 자료는 페이지도 길게 */
export function pageSizeFor(iw: number, ih: number): [number, number] {
  if (!iw || !ih) return [3200, 1800];
  return [3200, Math.round(Math.min(9000, Math.max(1800, (3200 * ih) / iw)))];
}

export function imageMeta(a: Asset) {
  return { asset: a.id, iw: a.w, ih: a.h, name: a.name, page: a.page_index, url: fileUrl(a) };
}

const kst = (t: number) => new Date(t + 9 * 3600e3).toISOString().slice(5, 16).replace("-", "/").replace("T", " ");

export class MediaStore {
  /** dbSize: 객체 전체 크기(판서 기록 포함). 자료는 MEDIA_QUOTA 와 '전체 예산 - 판서 기록' 중 작은 쪽까지 */
  constructor(private sql: SqlStorage, private budget = { total: Infinity, dbSize: () => 0 }) {}

  quota(): number {
    const other = Math.max(0, this.budget.dbSize() - this.usage());
    return Math.max(0, Math.min(MEDIA_QUOTA, this.budget.total - other));
  }

  migrate(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS assets (
        id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL, kind TEXT NOT NULL, set_id INTEGER NOT NULL DEFAULT 0,
        page_index INTEGER, pages INTEGER NOT NULL DEFAULT 1, name TEXT, sha TEXT, mime TEXT NOT NULL, thumb_mime TEXT,
        w INTEGER NOT NULL, h INTEGER NOT NULL, bytes INTEGER NOT NULL, created_at INTEGER NOT NULL,
        used_at INTEGER NOT NULL, done INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS assets_set ON assets(set_id);
      CREATE INDEX IF NOT EXISTS assets_sha ON assets(sha);
      CREATE TABLE IF NOT EXISTS asset_parts (
        asset_id INTEGER NOT NULL, part INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (asset_id, part));
    `);
  }

  get(id: number): Asset | null {
    return (this.sql.exec<Asset>("SELECT * FROM assets WHERE id = ?", id).toArray()[0] as Asset | undefined) ?? null;
  }
  setOf(setId: number): Asset[] {
    return this.sql.exec<Asset>("SELECT * FROM assets WHERE set_id = ? ORDER BY page_index, id", setId).toArray() as Asset[];
  }
  usage(): number {
    return this.sql.exec<{ n: number }>("SELECT COALESCE(SUM(bytes), 0) AS n FROM assets").one().n;
  }
  touch(setIds: number[]): void {
    const now = Date.now();
    for (const s of new Set(setIds)) this.sql.exec("UPDATE assets SET used_at = ? WHERE set_id = ?", now, s);
  }
  deleteSet(setId: number): void {
    this.sql.exec("DELETE FROM asset_parts WHERE asset_id IN (SELECT id FROM assets WHERE set_id = ?)", setId);
    this.sql.exec("DELETE FROM assets WHERE set_id = ?", setId);
  }

  /** 다 올라간 같은 파일이 있으면 그것을 다시 씀(같은 PDF 를 또 올릴 때 변환·전송 생략) */
  find(sha: string, kind: string) {
    const first = this.sql.exec<Asset>(
      "SELECT * FROM assets WHERE sha = ? AND kind = ? AND done = 1 ORDER BY id DESC LIMIT 1", sha, kind).toArray()[0] as Asset | undefined;
    if (!first) return null;
    this.touch([first.set_id]);
    const items = this.setOf(first.set_id);
    return { kind: first.kind, name: first.name ?? "", items: items.map(item), reused: true };
  }

  recent() {
    const rows = this.sql.exec<{ set_id: number; kind: string; name: string | null; n: number; created_at: number; used_at: number }>(
      `SELECT set_id, kind, name, COUNT(*) AS n, MIN(created_at) AS created_at, MAX(used_at) AS used_at
       FROM assets WHERE done = 1 GROUP BY set_id ORDER BY used_at DESC LIMIT 40`).toArray();
    const files = rows.map((r) => {
      const first = this.setOf(r.set_id)[0];
      return { asset: first.id, kind: r.kind, name: r.name ?? "", pages: r.n, created: kst(r.created_at), thumb: fileUrl(first, first.thumb_mime !== null) };
    });
    return { files, usage: this.usage(), quota: this.quota() };
  }

  /** 자리가 모자라면 오래 안 쓴 자료부터 지움(지금 올리는 묶음은 빼고) */
  private makeRoom(need: number, keepSet: number): void {
    let used = this.usage();
    const quota = this.quota();
    if (used + need <= quota) return;
    const sets = this.sql.exec<{ set_id: number; n: number }>(
      "SELECT set_id, SUM(bytes) AS n FROM assets WHERE set_id != ? GROUP BY set_id ORDER BY MAX(used_at) ASC", keepSet).toArray();
    for (const s of sets) {
      if (used + need <= quota) break;
      this.deleteSet(s.set_id);
      used -= s.n;
    }
    if (used + need > quota) throw new MediaError(507, "full", "저장 공간이 모자랍니다. 파일을 나눠 올려 주세요");
  }

  /**
   * 한 장(사진 1장 또는 PDF 한 쪽) 저장. 본문 = [미리보기 그림 thumbLen 바이트][본 그림].
   * 첫 장(i=0)은 묶음을 새로 만들고, 다음 장은 set 으로 이어 붙입니다. 마지막 장이 오면 묶음을 완성으로 표시.
   */
  put(q: { set: number; i: number; n: number; kind: string; name: string; sha: string; w: number; h: number; thumbLen: number }, body: Uint8Array): { set: number; item: ReturnType<typeof item>; done: boolean } {
    if (!KINDS.has(q.kind)) throw new MediaError(400, "bad_kind", "자료 종류가 맞지 않습니다");
    if (!Number.isInteger(q.n) || q.n < 1 || q.n > (q.kind === "pdf" ? MAX_PDF_PAGES : 1)) {
      throw new MediaError(400, "too_many_pages", `PDF 는 ${MAX_PDF_PAGES}쪽까지 올릴 수 있습니다. 나눠서 올려 주세요`);
    }
    if (!Number.isInteger(q.i) || q.i < 0 || q.i >= q.n) throw new MediaError(400, "bad_index", "쪽 번호가 맞지 않습니다");
    if (!Number.isInteger(q.w) || !Number.isInteger(q.h) || q.w < 1 || q.h < 1 || q.w > 10000 || q.h > 20000) throw new MediaError(400, "bad_size", "그림 크기가 맞지 않습니다");
    const tl = q.thumbLen;
    if (!Number.isInteger(tl) || tl < 0 || tl > MAX_THUMB_BYTES || tl >= body.length) throw new MediaError(400, "bad_thumb", "미리보기 그림이 맞지 않습니다");
    const thumb = tl ? body.subarray(0, tl) : null;
    const main = body.subarray(tl);
    if (main.length > MAX_IMAGE_BYTES) throw new MediaError(413, "too_large", "그림이 너무 큽니다");
    const mime = sniffImage(main);
    const thumbMime = thumb ? sniffImage(thumb) : null;
    if (!mime || (thumb && !thumbMime)) throw new MediaError(415, "bad_type", "그림(webp·jpg·png)만 받습니다");

    let setId = 0;
    if (q.i > 0) {
      const first = this.get(q.set);
      if (!first || first.set_id !== first.id || first.done || first.kind !== q.kind) throw new MediaError(400, "bad_set", "이어 올릴 자료를 찾지 못했습니다. 처음부터 다시 올려 주세요");
      if (this.sql.exec("SELECT 1 FROM assets WHERE set_id = ? AND page_index = ?", first.id, q.i).toArray().length) throw new MediaError(409, "dup_page", "이미 올린 쪽입니다");
      setId = first.id;
    }
    this.makeRoom(main.length + (thumb?.length ?? 0), setId);

    const now = Date.now();
    const id = this.sql.exec<{ id: number }>(
      `INSERT INTO assets (key, kind, set_id, page_index, pages, name, sha, mime, thumb_mime, w, h, bytes, created_at, used_at, done)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0) RETURNING id`,
      randomKey(12), q.kind, setId, q.kind === "pdf" ? q.i : null, q.n, q.name.slice(0, 200) || null, q.sha.slice(0, 64) || null,
      mime, thumbMime, q.w, q.h, main.length + (thumb?.length ?? 0), now, now).one().id;
    if (!setId) { setId = id; this.sql.exec("UPDATE assets SET set_id = ? WHERE id = ?", id, id); }
    for (let p = 0, off = 0; off < main.length; p++, off += PART) {
      this.sql.exec("INSERT INTO asset_parts (asset_id, part, data) VALUES (?, ?, ?)", id, p, main.subarray(off, off + PART));
    }
    if (thumb) this.sql.exec("INSERT INTO asset_parts (asset_id, part, data) VALUES (?, -1, ?)", id, thumb);

    const done = q.i === q.n - 1;
    if (done) {
      const got = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM assets WHERE set_id = ?", setId).one().n;
      if (got !== q.n) throw new MediaError(400, "missing_pages", "빠진 쪽이 있습니다. 처음부터 다시 올려 주세요");
      this.sql.exec("UPDATE assets SET done = 1 WHERE set_id = ?", setId);
    }
    return { set: setId, item: item(this.get(id)!), done };
  }

  /** 끝나지 않은 채 하루 넘게 남은 묶음(올리다 끊김) 정리 */
  sweep(): void {
    const old = this.sql.exec<{ set_id: number }>(
      "SELECT DISTINCT set_id FROM assets WHERE done = 0 AND created_at < ?", Date.now() - 86400e3).toArray();
    for (const s of old) this.deleteSet(s.set_id);
  }

  /** 파일 내려주기(로그인 없이, 키가 맞을 때만) */
  serve(id: number, key: string | null, thumb: boolean): Response {
    const a = this.get(id);
    if (!a || !key || key !== a.key) return new Response("not found", { status: 404 });
    const useThumb = thumb && a.thumb_mime !== null;
    const parts = this.sql.exec<{ data: ArrayBuffer }>(
      useThumb ? "SELECT data FROM asset_parts WHERE asset_id = ? AND part = -1"
        : "SELECT data FROM asset_parts WHERE asset_id = ? AND part >= 0 ORDER BY part", id).toArray();
    if (!parts.length) return new Response("not found", { status: 404 });
    const body = parts.length === 1 ? parts[0].data : new Blob(parts.map((p) => p.data));
    return new Response(body, {
      headers: {
        "content-type": useThumb ? a.thumb_mime! : a.mime,
        "cache-control": "public, max-age=31536000, immutable",
        "x-content-type-options": "nosniff",
      },
    });
  }
}
