/**
 * 확장판: 오래된 판서 기록을 R2 로 옮겨 보관합니다(재생 기록까지 그대로, 기간 제한 없이).
 *
 * 기본판은 칠판 저장소(DO 1GB)를 아끼려고 60일이 지난 '쓴 순서'를 지우지만, 확장판은 그 전에
 * 수업 하나를 통째로(페이지 상태 + 쓴 순서 + 미리보기) R2 의 `h/<수업 번호>.json.gz` 로 옮기고 DO 에서는 지웁니다.
 * 페이지 줄(번호·크기·배경)은 DO 에 남겨 목록·검색은 그대로 되고, 보거나 이어 쓰면 R2 에서 읽어 옵니다.
 */
type Json = Record<string, unknown>;

export const ARCHIVE_AFTER_DAYS = 60;

async function gzip(obj: unknown): Promise<Uint8Array> {
  const s = new Blob([JSON.stringify(obj)]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
async function gunzip(body: ReadableStream): Promise<Json> {
  return JSON.parse(await new Response(body.pipeThrough(new DecompressionStream("gzip"))).text()) as Json;
}
const b64 = (buf: ArrayBuffer) => { let s = ""; const u = new Uint8Array(buf); for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export type ArchivedPage = { id: number; page_no: number; state_json: string | null; state_seq: number;
  ops: { seq: number; kind: string; obj_id: string | null; data: string | null; ts: number; author: string | null }[] };

export class Archiver {
  private cache: { sid: number; data: Json } | null = null;
  constructor(private sql: SqlStorage, private r2: R2Bucket | undefined) {}

  migrate(): void {
    for (const col of ["archived INTEGER NOT NULL DEFAULT 0", "archive_bytes INTEGER NOT NULL DEFAULT 0", "archive_meta TEXT"]) {
      try { this.sql.exec(`ALTER TABLE sessions ADD COLUMN ${col}`); } catch { /* 이미 있음 */ }
    }
  }

  totalBytes(): number {
    return this.sql.exec<{ n: number }>("SELECT COALESCE(SUM(archive_bytes), 0) AS n FROM sessions WHERE archived = 1").one().n;
  }

  isArchived(sid: number): boolean {
    return !!this.sql.exec<{ a: number }>("SELECT archived AS a FROM sessions WHERE id = ?", sid).toArray()[0]?.a;
  }

  /**
   * 오래된 수업 하나를 R2 로. room 은 지금 칠판에 열린 수업(옮기면 안 됨).
   * 돌려줌: 'done' 옮김 | 'none' 옮길 것 없음 | 'full' R2 한도에 걸림(대신 기본판처럼 정리해야 함)
   */
  async archiveOne(cutoffDay: string, openSession: number | null, roomLeft: number): Promise<"done" | "none" | "full"> {
    if (!this.r2) return "none";
    const s = this.sql.exec<{ id: number }>(
      `SELECT id FROM sessions WHERE archived = 0 AND deleted = 0 AND day < ? AND id != ?
       AND EXISTS (SELECT 1 FROM pages p WHERE p.session_id = sessions.id AND (p.state_json IS NOT NULL OR p.last_seq > 0))
       ORDER BY day, id LIMIT 1`, cutoffDay, openSession ?? -1).toArray()[0];
    if (!s) return "none";
    const pages = this.sql.exec<{ id: number; page_no: number; state_json: string | null; state_seq: number }>(
      "SELECT id, page_no, state_json, state_seq FROM pages WHERE session_id = ? ORDER BY page_no", s.id).toArray();
    const out: ArchivedPage[] = [];
    const thumbs: number[] = [];
    for (const p of pages) {
      const ops = this.sql.exec<ArchivedPage["ops"][number]>(
        "SELECT seq, kind, obj_id, data, ts, author FROM ops WHERE page_id = ? ORDER BY seq", p.id).toArray();
      out.push({ ...p, ops });
    }
    const body = await gzip({ v: 1, session: s.id, pages: out });
    if (body.length > roomLeft) return "full";
    await this.r2.put(`h/${s.id}.json.gz`, body, { httpMetadata: { contentType: "application/gzip" } });
    let bytes = body.length;
    for (const p of pages) {
      const t = this.sql.exec<{ data: ArrayBuffer; seq: number }>("SELECT data, seq FROM page_thumbs WHERE page_id = ?", p.id).toArray()[0];
      if (!t) continue;
      await this.r2.put(`t/${p.id}`, t.data, { httpMetadata: { contentType: "image/webp" }, customMetadata: { seq: String(t.seq) } });
      thumbs.push(p.id); bytes += t.data.byteLength;
    }
    // R2 에 다 올라간 뒤에만 DO 에서 지움
    for (const p of pages) {
      this.sql.exec("DELETE FROM ops WHERE page_id = ?", p.id);
      this.sql.exec("DELETE FROM page_thumbs WHERE page_id = ?", p.id);
    }
    this.sql.exec("UPDATE pages SET state_json = NULL, state_seq = 0 WHERE session_id = ?", s.id);
    this.sql.exec("UPDATE sessions SET archived = 1, archive_bytes = ?, archive_meta = ? WHERE id = ?", bytes, JSON.stringify({ thumbs }), s.id);
    return "done";
  }

  /** 보관한 수업 읽기(같은 수업을 이어서 볼 때를 위해 하나만 기억) */
  async load(sid: number): Promise<{ pages: ArchivedPage[] } | null> {
    if (this.cache?.sid === sid) return this.cache.data as { pages: ArchivedPage[] };
    if (!this.r2) return null;
    const obj = await this.r2.get(`h/${sid}.json.gz`);
    if (!obj) return null;
    const data = await gunzip(obj.body);
    this.cache = { sid, data };
    return data as { pages: ArchivedPage[] };
  }

  thumbsOf(sid: number): number[] {
    const m = this.sql.exec<{ m: string | null }>("SELECT archive_meta AS m FROM sessions WHERE id = ?", sid).toArray()[0]?.m;
    try { return (JSON.parse(m ?? "{}").thumbs as number[]) ?? []; } catch { return []; }
  }

  async thumb(pid: number): Promise<ArrayBuffer | null> {
    const o = this.r2 ? await this.r2.get(`t/${pid}`) : null;
    return o ? o.arrayBuffer() : null;
  }

  /** 다시 칠판에 열 때: R2 에서 DO 로 되돌림 */
  async restore(sid: number): Promise<boolean> {
    if (!this.isArchived(sid)) return true;
    const data = await this.load(sid);
    if (!data) return false;
    const thumbs = this.thumbsOf(sid);
    for (const p of data.pages) {
      this.sql.exec("UPDATE pages SET state_json = ?, state_seq = ? WHERE id = ?", p.state_json, p.state_seq, p.id);
      for (const o of p.ops) {
        this.sql.exec("INSERT OR IGNORE INTO ops (page_id, seq, kind, obj_id, data, ts, author) VALUES (?, ?, ?, ?, ?, ?, ?)",
          p.id, o.seq, o.kind, o.obj_id, o.data, o.ts, o.author);
      }
    }
    for (const pid of thumbs) {
      const o = this.r2 ? await this.r2.get(`t/${pid}`) : null;
      if (o) this.sql.exec("INSERT OR REPLACE INTO page_thumbs (page_id, seq, data) VALUES (?, ?, ?)", pid, Number(o.customMetadata?.seq ?? 0), await o.arrayBuffer());
    }
    this.sql.exec("UPDATE sessions SET archived = 0, archive_bytes = 0, archive_meta = NULL WHERE id = ?", sid);
    await this.remove(sid, thumbs);
    return true;
  }

  /** R2 의 보관본 지우기(수업을 지울 때, 되돌린 뒤) */
  async remove(sid: number, thumbs = this.thumbsOf(sid)): Promise<void> {
    if (this.cache?.sid === sid) this.cache = null;
    if (!this.r2) return;
    await this.r2.delete([`h/${sid}.json.gz`, ...thumbs.map((p) => `t/${p}`)]).catch(() => {});
  }

  /** 백업용: 보관한 수업의 페이지 상태·쓴 순서·미리보기를 DO 에 있을 때와 같은 모양으로 */
  async expand(sid: number): Promise<{ pages: ArchivedPage[]; thumbs: { page_id: number; seq: number; b64: string }[] } | null> {
    const data = await this.load(sid);
    if (!data) return null;
    const thumbs = [];
    for (const pid of this.thumbsOf(sid)) {
      const o = this.r2 ? await this.r2.get(`t/${pid}`) : null;
      if (o) thumbs.push({ page_id: pid, seq: Number(o.customMetadata?.seq ?? 0), b64: b64(await o.arrayBuffer()) });
    }
    return { pages: data.pages, thumbs };
  }
}

export { b64, unb64 };
