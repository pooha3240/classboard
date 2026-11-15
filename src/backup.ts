/**
 * 백업 내려받기·되살리기(기본판·저장판 모두).
 * 기본판으로 되살릴 때 자료가 기본판 한도(700MB)를 넘으면 넘는 자료는 건너뜁니다.
 *
 * 무료 플랜은 요청 한 번에 쓸 수 있는 CPU 가 적어서, 서버가 파일 하나를 통째로 만들지 않습니다.
 * 브라우저가 part 를 차례로 받아(한 번에 1MB 안팎) 줄 단위 JSON(NDJSON)으로 이어 붙이고 gzip 으로 묶어 저장합니다.
 * 되살리기도 브라우저가 파일을 풀어 몇 MB 씩 나눠 보냅니다.
 *
 * 줄 종류: meta(첫 줄) · config · row(표 한 줄) · arch(R2 로 옮긴 수업을 펼친 것) · blob(자료 한 장: 기록 + 그림)
 * 교사 계정(비밀번호·서명 키)·학급 코드·PIN·전자칠판 등록·나이스 인증키는 넣지 않습니다(옮긴 곳의 것을 그대로 씀).
 */
import type { MediaStore, Asset } from "./media";
import { r2Key } from "./media";
import type { Archiver } from "./archive";
import { b64, unb64 } from "./archive";

type Json = Record<string, unknown>;

export const BACKUP_VERSION = 1;
/** 되살릴 때 이 순서로 넣음(참조하는 쪽이 뒤) */
const TABLES = ["bells", "timetable", "arrangements", "plan_term", "plan_tt", "plan_slot", "plan_lesson", "plan_edit", "plan_media",
  "sessions", "pages", "ops", "page_thumbs"] as const;
const BLOB_COLS: Record<string, string[]> = { page_thumbs: ["data"] };
const CONFIG_KEYS = ["teacher_name", "grade", "class", "size", "class_color", "neis_office", "neis_school", "neis_school_name", "neis_kind"];
const PART_BYTES = 900_000;
const PART_ROWS = 3000;

export class BackupError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

type Cursor = { s: number; after: number };   // s: 0..TABLES-1 표, TABLES 보관 수업, TABLES+1 자료 그림

export class Backup {
  private cols = new Map<string, Set<string>>();
  constructor(private sql: SqlStorage, private media: MediaStore, private archive: Archiver,
    private cfg: (k: string) => string | null, private setCfg: (k: string, v: string | null) => void) {}

  private columns(t: string): Set<string> {
    if (!this.cols.has(t)) this.cols.set(t, new Set(this.sql.exec<{ name: string }>(`PRAGMA table_info(${t})`).toArray().map((r) => r.name)));
    return this.cols.get(t)!;
  }

  /** 백업 한 조각. cursor 가 없으면 처음(meta·config 줄부터). next 가 null 이면 끝. */
  async part(cursorIn: string | null, withMedia: boolean, version: string, edition: string): Promise<{ lines: Json[]; next: string | null }> {
    const lines: Json[] = [];
    let cur: Cursor = cursorIn ? JSON.parse(cursorIn) : { s: 0, after: 0 };
    if (!cursorIn) {
      lines.push({ t: "meta", v: BACKUP_VERSION, version, edition, media: withMedia, at: Date.now(),
        klass: { grade: Number(this.cfg("grade")), class: Number(this.cfg("class")), size: Number(this.cfg("size")) } });
      const conf: Json = {};
      for (const k of CONFIG_KEYS) { const v = this.cfg(k); if (v !== null) conf[k] = v; }
      lines.push({ t: "config", values: conf });
    }
    let bytes = 0;
    const push = (o: Json) => { lines.push(o); bytes += JSON.stringify(o).length; };
    while (bytes < PART_BYTES) {
      if (cur.s < TABLES.length) {
        const t = TABLES[cur.s];
        const rows = this.sql.exec<Record<string, SqlStorageValue>>(`SELECT rowid AS _rid, * FROM ${t} WHERE rowid > ? ORDER BY rowid LIMIT ?`, cur.after, PART_ROWS).toArray() as unknown as Json[];
        if (!rows.length) { cur = { s: cur.s + 1, after: 0 }; continue; }
        for (const r of rows) {
          const rid = Number(r._rid); delete r._rid;
          for (const c of BLOB_COLS[t] ?? []) if (r[c] instanceof ArrayBuffer) r[c] = { b64: b64(r[c] as ArrayBuffer) };
          if (t === "sessions") { r.archived = 0; r.archive_bytes = 0; r.archive_meta = null; }   // 되살린 곳에서는 칠판 저장소에 펼쳐 둠
          push({ t: "row", table: t, r });
          cur.after = rid;
          if (bytes >= PART_BYTES) break;
        }
        continue;
      }
      if (cur.s === TABLES.length) {                    // R2 로 옮긴 수업: 한 번에 하나씩 펼쳐서
        const s = this.sql.exec<{ id: number }>("SELECT id FROM sessions WHERE archived = 1 AND id > ? ORDER BY id LIMIT 1", cur.after).toArray()[0];
        if (!s) { cur = { s: cur.s + 1, after: 0 }; continue; }
        const x = await this.archive.expand(s.id);
        if (x) push({ t: "arch", session: s.id, pages: x.pages, thumbs: x.thumbs });
        cur.after = s.id;
        continue;
      }
      if (cur.s === TABLES.length + 1 && withMedia) {   // 자료 그림: 한 장씩
        const a = this.sql.exec<Asset>("SELECT * FROM assets WHERE done = 1 AND id > ? ORDER BY id LIMIT 1", cur.after).toArray()[0] as Asset | undefined;
        if (!a) { cur = { s: cur.s + 1, after: 0 }; continue; }
        const got = await this.readAsset(a);
        if (got) push({ t: "blob", asset: { ...a, loc: undefined }, main: b64(got.main), thumb: got.thumb ? b64(got.thumb) : null });
        cur.after = a.id;
        continue;
      }
      return { lines, next: null };
    }
    return { lines, next: JSON.stringify(cur) };
  }

  private async readAsset(a: Asset): Promise<{ main: ArrayBuffer; thumb: ArrayBuffer | null } | null> {
    if (a.loc === "r2") {
      const r2 = this.media.r2;
      if (!r2) return null;
      const m = await r2.get(r2Key(a)); if (!m) return null;
      const t = a.thumb_mime ? await r2.get(r2Key(a, true)) : null;
      return { main: await m.arrayBuffer(), thumb: t ? await t.arrayBuffer() : null };
    }
    const parts = this.sql.exec<{ part: number; data: ArrayBuffer }>("SELECT part, data FROM asset_parts WHERE asset_id = ? ORDER BY part", a.id).toArray();
    const main = parts.filter((p) => p.part >= 0).map((p) => new Uint8Array(p.data));
    if (!main.length) return null;
    const all = new Uint8Array(main.reduce((n, u) => n + u.length, 0));
    let off = 0; for (const u of main) { all.set(u, off); off += u.length; }
    const th = parts.find((p) => p.part === -1);
    return { main: all.buffer, thumb: th ? th.data : null };
  }

  /* ───────── 되살리기 ───────── */

  /** 지금 내용(판서·진도표·자료·설정 일부)을 모두 지움. 교사 계정·학급 코드·전자칠판 등록은 남김. */
  async wipe(): Promise<void> {
    for (const t of [...TABLES, "grants", "asset_parts", "assets"]) this.sql.exec(`DELETE FROM ${t}`);
    for (const k of ["room_session", "room_period", "room_page", "room_day"]) this.setCfg(k, null);
    const r2 = this.media.r2;
    if (r2) {                                           // 이 설치 전용 버킷: 자료·보관 수업을 모두 지움
      for (const prefix of ["m/", "h/", "t/"]) {
        let cursor: string | undefined;
        do {
          const l = await r2.list({ prefix, cursor, limit: 1000 });
          if (l.objects.length) await r2.delete(l.objects.map((o) => o.key));
          cursor = l.truncated ? l.cursor : undefined;
        } while (cursor);
      }
    }
  }

  /** 줄 묶음 하나 넣기 */
  async rows(lines: Json[]): Promise<{ rows: number; blobs: number; skipped: number }> {
    let rows = 0, blobs = 0, skipped = 0;
    for (const ln of lines) {
      if (ln.t === "config") {
        const v = (ln.values ?? {}) as Json;
        for (const k of CONFIG_KEYS) if (typeof v[k] === "string") this.setCfg(k, v[k] as string);
      } else if (ln.t === "row") {
        const t = String(ln.table);
        if (!(TABLES as readonly string[]).includes(t)) { skipped++; continue; }
        const have = this.columns(t);
        const r = (ln.r ?? {}) as Json;
        const keys = Object.keys(r).filter((k) => have.has(k));
        if (!keys.length) { skipped++; continue; }
        const vals = keys.map((k) => {
          const v = r[k];
          if (v && typeof v === "object" && "b64" in (v as Json)) return unb64(String((v as Json).b64));
          return v as string | number | null;
        });
        this.sql.exec(`INSERT OR REPLACE INTO ${t} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`, ...vals);
        rows++;
      } else if (ln.t === "arch") {
        for (const p of (ln.pages ?? []) as { id: number; state_json: string | null; state_seq: number; ops: Json[] }[]) {
          this.sql.exec("UPDATE pages SET state_json = ?, state_seq = ? WHERE id = ?", p.state_json, p.state_seq, p.id);
          for (const o of p.ops) {
            this.sql.exec("INSERT OR IGNORE INTO ops (page_id, seq, kind, obj_id, data, ts, author) VALUES (?, ?, ?, ?, ?, ?, ?)",
              p.id, o.seq as number, o.kind as string, (o.obj_id ?? null) as string | null, (o.data ?? null) as string | null, o.ts as number, (o.author ?? null) as string | null);
            rows++;
          }
        }
        for (const th of (ln.thumbs ?? []) as { page_id: number; seq: number; b64: string }[]) {
          this.sql.exec("INSERT OR REPLACE INTO page_thumbs (page_id, seq, data) VALUES (?, ?, ?)", th.page_id, th.seq, unb64(th.b64));
        }
      } else if (ln.t === "blob") {
        if (await this.putBlob(ln)) blobs++; else skipped++;
      }
    }
    return { rows, blobs, skipped };
  }

  /** 자료 한 장: 같은 번호·키로 넣어 판서·진도표에 깔린 주소가 그대로 맞게 */
  private async putBlob(ln: Json): Promise<boolean> {
    const a = ln.asset as Json;
    const main = unb64(String(ln.main ?? "")), thumb = ln.thumb ? unb64(String(ln.thumb)) : null;
    if (!a || !main.length) return false;
    const r2 = this.media.r2;
    const id = Number(a.id), key = String(a.key);
    if (!Number.isInteger(id) || !/^[A-Za-z0-9_-]{8,40}$/.test(key)) return false;
    if (!r2 && this.media.usage("do") + main.length > this.media.quota()) return false;      // 기본판 한도를 넘으면 건너뜀
    if (r2) {
      const meta = (ct: string) => ({ httpMetadata: { contentType: ct, cacheControl: "public, max-age=31536000, immutable" } });
      await r2.put(r2Key({ id, key }), main, meta(String(a.mime)));
      if (thumb && a.thumb_mime) await r2.put(r2Key({ id, key }, true), thumb, meta(String(a.thumb_mime)));
    }
    const cols = ["id", "key", "kind", "set_id", "page_index", "pages", "name", "sha", "mime", "thumb_mime", "w", "h", "bytes", "created_at", "used_at", "done", "loc"];
    const row = { ...a, loc: r2 ? "r2" : "do", done: 1 } as Json;
    this.sql.exec(`INSERT OR REPLACE INTO assets (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
      ...cols.map((c) => (row[c] ?? null) as string | number | null));
    if (!r2) {
      this.sql.exec("DELETE FROM asset_parts WHERE asset_id = ?", id);
      for (let p = 0, off = 0; off < main.length; p++, off += 1_900_000) {
        this.sql.exec("INSERT INTO asset_parts (asset_id, part, data) VALUES (?, ?, ?)", id, p, main.subarray(off, off + 1_900_000));
      }
      if (thumb) this.sql.exec("INSERT INTO asset_parts (asset_id, part, data) VALUES (?, -1, ?)", id, thumb);
    }
    return true;
  }
}
