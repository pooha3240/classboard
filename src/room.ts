/**
 * 학급 Durable Object — 설치 하나 = 학급 하나 = 이 객체 하나
 *
 * 계정·학급 설정·수업(세션)·페이지·판서 동작을 모두 이 객체의 SQLite 에 둡니다.
 * 판서 동기화 규칙은 jmschool판 board.py 와 같습니다.
 * - 클라이언트는 먼저 그리고 op:batch 로 보냅니다. 서버가 페이지별 순번(seq)을 매겨 저장한 뒤
 *   방 전체(보낸 기기 포함)에 뿌립니다. 보낸 기기는 cid 로 자기 것을 알아봅니다.
 * - 그리는 중인 획(stroke:live)은 저장하지 않고 다른 기기에만 전달합니다.
 *
 * WebSocket 메시지(JSON):
 *   기기 → 서버  {c?: 번호, e: 이벤트, d: 데이터}   c 가 있으면 응답을 기다리는 호출
 *   서버 → 기기  {a: 번호, d: 응답}  또는  {e: 이벤트, d: 데이터}
 *   "ping" → "pong" 은 자동 응답(DO를 깨우지 않음)
 */
import { DurableObject } from "cloudflare:workers";
import { Archiver, ARCHIVE_AFTER_DAYS } from "./archive";
import { Backup, BACKUP_VERSION } from "./backup";
import { PlanStore, PlanError, neisCall, neisSchools, NEIS_TT, type NeisCfg } from "./plan";
import { MediaStore, MediaError, MAX_PDF_PAGES, R2_CAP, imageMeta, pageSizeFor, sniffImage } from "./media";
import { sign, verify, TokenError, randomKey, hashPassword, checkPassword, sha256, shortSig, type TokenPayload } from "./lib/token";
import { currentPeriod, kstNow, nextBoundary, periodLabel, normalize, type Bell } from "./lib/periods";
import {
  OpError, ID_RE, KINDS, BG_TYPES, MAX_LIVE_POINTS, MAX_OPS_PER_BATCH,
  validateObj, cleanWebUrl, cleanColor, num, localVideoMeta, type Obj,
} from "./lib/validate";

export const SERVER_VERSION = "0.13.0";

const TEACHER_DEVICES = new Set(["display", "teacher-pc", "teacher-tablet"]);
const TOKEN_DAYS = 30;
const DEVICE_TOKEN_HOURS = 12;        // 등록 전자칠판: 기기 키로 12시간짜리 토큰을 계속 새로 받음
const PIN_TTL_S = 10 * 60;            // PIN 을 풀면 10분 동안 교사 권한
const PIN_MAX_FAILS = 5;
const PIN_LOCK_MS = 5 * 60_000;
const PIN_RE = /^\d{4,6}$/;
const DB_BUDGET = 950 * 1000 * 1000;   // 무료 플랜 객체당 1GB 중 이만큼까지(자료는 남는 만큼만)
const OPS_KEEP_DAYS = 60;              // 판서 재생용 동작 기록은 60일까지(그 뒤에는 완성된 판서만 남음)
const MAX_THUMB = 200 * 1024;
const SNAP_EVERY_OPS = 50;
const SNAP_IDLE_MS = 15_000;

interface Att {
  id: string;
  dev?: number;                       // 등록 전자칠판이면 기기 번호
  sub: string;
  name: string;
  role: "teacher" | "student";
  device: string;
  joined: boolean;
  num?: number;            // 학생 번호
  grant?: number | null;   // 학생이 지금 칠판에 풀고 있는 호출
}

type Grant = { id: number; num: number; mode: string; status: string; expires: number; done: number };
const OPEN = ["waiting", "active"];
const WAIT_MS = 3 * 60_000;       // 학생이 받기까지
const ACTIVE_MS = 20 * 60_000;    // 시작한 뒤 최대(10분씩 늘릴 수 있음)
const MAX_OPEN = 8;
const STUDENT_TOKEN_HOURS = 12;
// 헷갈리는 글자(0·O·1·I·L)를 뺀 학급 코드 글자
const CODE_RE = /^\d{6}$/;
const CODE_FAIL_MAX = 30;            // IP당 10분에 틀린 코드 30번까지(학교는 IP 하나를 같이 씀)
const CODE_FAIL_WINDOW = 10 * 60_000;

type Json = Record<string, unknown>;
type Ack = Json | undefined;

type PageRow = {
  id: number; session_id: number; page_no: number; w: number; h: number;
  bg_type: string; bg_meta: string | null; bg_color: string | null;
  state_json: string | null; state_seq: number;
};
type Row = Record<string, SqlStorageValue>;

class PageState {
  id: number; session_id: number; page_no: number; w: number; h: number;
  bg_type: string; bg_meta: Json; bg_color: string | null;
  objs = new Map<string, Obj>();     // 넣은 순서 = 그리는 순서
  authors = new Map<string, string>();
  seq: number; saved_seq: number; last_change = 0;
  play: { playing: boolean; pos: number; at: number } | null = null;   // 유튜브 배경 재생 상태(메모리에서만)

  constructor(r: PageRow) {
    this.id = r.id; this.session_id = r.session_id; this.page_no = r.page_no; this.w = r.w; this.h = r.h;
    this.bg_type = r.bg_type; this.bg_meta = r.bg_meta ? JSON.parse(r.bg_meta) : {}; this.bg_color = r.bg_color;
    this.seq = r.state_seq || 0; this.saved_seq = this.seq;
  }

  apply(kind: string, id: string | null, data: Obj | null): boolean {
    if (kind === "add") { if (this.objs.has(id!)) return false; this.objs.set(id!, data!); }
    else if (kind === "update") { if (!this.objs.has(id!)) return false; this.objs.set(id!, data!); }
    else if (kind === "remove") { if (!this.objs.delete(id!)) return false; }
    else if (kind === "clear") { if (!this.objs.size) return false; this.objs.clear(); }
    return true;
  }

  meta(): Json {
    return { id: this.id, page_no: this.page_no, w: this.w, h: this.h, bg_type: this.bg_type,
      bg_meta: this.bg_meta, bg_url: (this.bg_type === "image" || this.bg_type === "pdf") ? (this.bg_meta.url as string) ?? null : null,
      bg_color: this.bg_color, play: this.play ? { ...this.play, now: Date.now() / 1000 } : null };
  }
  toClient(): Json { return { ...this.meta(), seq: this.seq, objs: [...this.objs.values()] }; }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
const fail = (status: number, error: string, message: string) => json({ detail: { error, message } }, status);

export class ClassRoom extends DurableObject<Record<string, unknown>> {
  private sql: SqlStorage;
  private media: MediaStore;
  private plan: PlanStore;
  private r2: R2Bucket | undefined;
  private archive: Archiver;
  private backup: Backup;
  private pages = new Map<number, PageState>();
  private loginFails = { n: 0, until: 0 };
  private pinFails = new Map<number, { n: number; until: number }>();

  constructor(ctx: DurableObjectState, env: Record<string, unknown>) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.r2 = (env.FILES as R2Bucket | undefined) ?? undefined;       // 확장판이면 R2 가 연결됨
    this.media = new MediaStore(this.sql, { total: DB_BUDGET, dbSize: () => this.sql.databaseSize, pinned: () => this.plan.pinnedSets(),
      r2: this.r2, archived: () => this.archivedBytes() });
    this.plan = new PlanStore(this.sql, this.media);
    this.archive = new Archiver(this.sql, this.r2);
    this.backup = new Backup(this.sql, this.media, this.archive, (k) => this.cfg(k), (k, v) => this.setCfg(k, v));
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    ctx.blockConcurrencyWhile(async () => this.migrate());
  }

  /* ───────────── 저장소 ───────────── */

  private migrate(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS config (k TEXT PRIMARY KEY, v TEXT);
      CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, day TEXT NOT NULL, period_from INTEGER, period_to INTEGER,
        subject TEXT NOT NULL DEFAULT '', lesson TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS sessions_day ON sessions(day);
      CREATE TABLE IF NOT EXISTS pages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER NOT NULL, page_no INTEGER NOT NULL,
        w INTEGER NOT NULL DEFAULT 3200, h INTEGER NOT NULL DEFAULT 1800, bg_type TEXT NOT NULL DEFAULT 'none',
        bg_meta TEXT, bg_color TEXT, state_json TEXT, state_seq INTEGER NOT NULL DEFAULT 0,
        last_seq INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS pages_session ON pages(session_id);
      CREATE TABLE IF NOT EXISTS ops (
        page_id INTEGER NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL, obj_id TEXT, data TEXT,
        ts INTEGER NOT NULL, author TEXT, PRIMARY KEY (page_id, seq));
      CREATE TABLE IF NOT EXISTS arrangements (
        id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, name TEXT NOT NULL DEFAULT '',
        config TEXT, result TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS bells (period INTEGER PRIMARY KEY, start TEXT NOT NULL, end_ TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS devices (
        id INTEGER PRIMARY KEY AUTOINCREMENT, key_hash TEXT NOT NULL UNIQUE, label TEXT NOT NULL,
        created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS grants (
        id INTEGER PRIMARY KEY AUTOINCREMENT, num INTEGER NOT NULL, mode TEXT NOT NULL, status TEXT NOT NULL,
        expires INTEGER NOT NULL, done INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
    `);
    this.media.migrate();
    this.archive.migrate();
    this.plan.migrate();
    this.sql.exec(`CREATE TABLE IF NOT EXISTS timetable (weekday INTEGER NOT NULL, period INTEGER NOT NULL, subject TEXT NOT NULL, PRIMARY KEY (weekday, period))`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS page_thumbs (page_id INTEGER PRIMARY KEY, seq INTEGER NOT NULL, data BLOB NOT NULL)`);
  }

  private cfg(k: string): string | null {
    return this.sql.exec<{ v: string }>("SELECT v FROM config WHERE k = ?", k).toArray()[0]?.v ?? null;
  }
  private setCfg(k: string, v: string | number | null): void {
    if (v === null) this.sql.exec("DELETE FROM config WHERE k = ?", k);
    else this.sql.exec("INSERT INTO config (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, String(v));
  }
  private configured(): boolean { return !!this.cfg("secret"); }
  private archivedBytes(): number { return this.archive ? this.archive.totalBytes() : 0; }

  /* 나이스 시간표 자동 받기(선택): 교사가 설정에서 인증키·학교를 넣으면 켜짐 */
  private neisCfg(): NeisCfg | null {
    const key = this.cfg("neis_key"), school = this.cfg("neis_school"), office = this.cfg("neis_office");
    if (!key || !school || !office) return null;
    const base = String((this.env as Record<string, unknown>).NEIS_BASE || "https://open.neis.go.kr/hub");
    return { key, office, school, kind: this.cfg("neis_kind") || "초등학교", base };
  }
  /** 다음 받을 때: 매일 새벽 5시 40분(KST) 즈음, 학교마다 몇 분씩 흩어지게 */
  private neisNextAt(): number {
    const now = Date.now();
    const kstMidnight = Math.floor((now + 9 * 3600e3) / 86400e3) * 86400e3 - 9 * 3600e3;
    let at = kstMidnight + (5 * 60 + 40 + Math.floor(Math.random() * 15)) * 60e3;
    if (at <= now) at += 86400e3;
    return at;
  }
  private async neisSync(opts: { termId?: number; force?: boolean } = {}) {
    const cfg = this.neisCfg();
    if (!cfg) throw new PlanError(400, "neis_off", "나이스 인증키가 설정되어 있지 않습니다(교시·시간표 설정에서 넣을 수 있습니다)");
    try {
      const results = await this.plan.syncNeis(cfg, this.klass(), kstNow().day, opts);
      this.setCfg("neis_last", JSON.stringify({ ok: true, at: Date.now(), rows: results.reduce((n, r) => n + (r.rows || 0), 0),
        changed: results.some((r) => r.changed) }));
      this.relabelSessions(results.flatMap((r) => (r.last ? [kstNow().day] : [])));
      return results;
    } catch (e) {
      if (e instanceof PlanError) this.setCfg("neis_last", JSON.stringify({ ok: false, at: Date.now(), error: e.message }));
      throw e;
    }
  }
  private klass(): { grade: number; class: number; size: number } {
    return { grade: Number(this.cfg("grade")), class: Number(this.cfg("class")), size: Number(this.cfg("size") || 0) };
  }
  private bells(): Bell[] {
    return this.sql.exec<{ period: number; start: string; end_: string }>("SELECT period, start, end_ FROM bells").toArray()
      .map((r) => [r.period, r.start, r.end_] as Bell);
  }

  /* ───────────── 인증 ───────────── */

  private async tokenFor(p: Partial<TokenPayload> & { sub: string; role: "teacher" | "student" }, days = TOKEN_DAYS) {
    const now = Math.floor(Date.now() / 1000);
    const k = this.klass();
    const exp = now + days * 86400;
    const payload: TokenPayload = { v: 1, school: 1, grade: k.grade, class: k.class, iat: now, exp, ...p };
    return { token: await sign(this.cfg("secret")!, payload), exp };
  }

  private async user(req: Request): Promise<TokenPayload | null> {
    const h = req.headers.get("Authorization");
    if (!h?.startsWith("Bearer ") || !this.configured()) return null;
    try { return this.checkStudentCode(await verify(this.cfg("secret")!, h.slice(7))); } catch { return null; }
  }

  /** 학생 토큰은 발급 때의 학급 코드 판이 지금과 같아야 합니다. */
  private checkStudentCode(p: TokenPayload): TokenPayload {
    if (p.role === "student" && (this.classCode(), p.cv) !== Number(this.cfg("code_ver") || 0)) throw new TokenError("code_changed");
    return p;
  }

  /* ───────────── 전자칠판 등록·PIN ───────────── */

  private device(id: number | null | undefined): { id: number; label: string; created_at: number; last_seen: number } | null {
    if (!id) return null;
    return this.sql.exec<{ id: number; label: string; created_at: number; last_seen: number }>(
      "SELECT id, label, created_at, last_seen FROM devices WHERE id = ?", id).toArray()[0] ?? null;
  }
  private devPublic(d: { id: number; label: string }) {
    const k = this.klass();
    return { id: d.id, label: d.label, grade: k.grade, class: k.class };
  }
  private async deviceToken(d: { id: number; label: string }, pinUntil?: number) {
    const k = this.klass();
    return this.tokenFor({ sub: this.cfg("login_id")!, name: d.label, role: "teacher", dev: d.id, lg: k.grade, lc: k.class,
      ...(pinUntil ? { pin: pinUntil } : {}) }, DEVICE_TOKEN_HOURS / 24);
  }
  /** 로그인한 교사 기기는 늘 교사 권한, 등록 전자칠판은 PIN 을 푼 10분 동안만. */
  private elevated(u: TokenPayload): boolean {
    return !u.dev || (!!u.pin && u.pin > Date.now() / 1000);
  }
  private closeDeviceSockets(id: number): void {
    for (const ws of this.ctx.getWebSockets()) {
      if (this.att(ws)?.dev === id) { try { ws.send(JSON.stringify({ e: "auth-error", d: { error: "device_revoked" } })); ws.close(4001, "device_revoked"); } catch { /* 이미 닫힘 */ } }
    }
  }

  /* ───────────── 학급 코드 ───────────── */

  private newCode(): string {
    const r = new Uint32Array(1);
    do crypto.getRandomValues(r); while (r[0] >= 4_294_000_000);   // 치우침 없이 000000~999999
    return String(r[0] % 1_000_000).padStart(6, "0");
  }
  private classCode(): string {
    let c = this.cfg("class_code");
    if (!c || !CODE_RE.test(c)) {                 // 0.2.0의 영문 코드는 숫자 코드로 바꿈(학생은 다시 들어와야 함)
      c = this.newCode(); this.setCfg("class_code", c);
      this.setCfg("code_ver", Number(this.cfg("code_ver") || 0) + 1);
    }
    return c;
  }
  private codeFails = new Map<string, { n: number; reset: number }>();
  private codeLocked(ip: string): boolean {
    const f = this.codeFails.get(ip);
    return !!f && Date.now() < f.reset && f.n >= CODE_FAIL_MAX;
  }
  private codeFailed(ip: string): void {
    const now = Date.now();
    let f = this.codeFails.get(ip);
    if (!f || now >= f.reset) { f = { n: 0, reset: now + CODE_FAIL_WINDOW }; this.codeFails.set(ip, f); }
    f.n++;
    if (this.codeFails.size > 1000) for (const [k, v] of this.codeFails) if (now >= v.reset) this.codeFails.delete(k);
  }
  private codeMatches(input: unknown): boolean {
    const want = this.classCode();
    const got = String(input ?? "").replace(/\D/g, "");
    if (got.length !== want.length) return false;
    let d = 0;
    for (let i = 0; i < got.length; i++) d |= got.charCodeAt(i) ^ want.charCodeAt(i);
    return d === 0;
  }

  /* ───────────── REST (/eboard-api/…) ───────────── */

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/ws") return this.acceptSocket(req, url);
    const path = url.pathname.replace(/^\/eboard-api/, "");
    try {
      return await this.rest(req, path, url);
    } catch (e) {
      return fail(500, "server", String(e));
    }
  }

  private async rest(req: Request, path: string, url: URL): Promise<Response> {
    const method = req.method;
    const body = async () => (await req.json().catch(() => ({}))) as Json;

    if (path === "/setup/status" && method === "GET") {
      return json({ configured: this.configured(), ...(this.configured() ? { klass: this.klass() } : {}) });
    }
    if (path === "/setup" && method === "POST") {
      // 설치 키 확인은 Worker 가 하고, 확인된 요청에만 이 머리글을 붙입니다.
      if (req.headers.get("x-cb-setup") !== "ok") return fail(403, "bad_setup_key", "설치 키가 맞지 않습니다");
      const b = await body();
      const reset = this.configured();
      const loginId = String(b.login_id ?? "").trim();
      const pw = String(b.password ?? "");
      if (!/^[A-Za-z0-9_.-]{3,30}$/.test(loginId)) return fail(400, "bad_login_id", "아이디는 영문·숫자 3~30자입니다");
      if (pw.length < 8) return fail(400, "bad_password", "비밀번호는 8자 이상입니다");
      if (reset) {
        // 비밀번호를 잊었거나 계정이 새었을 때: 모든 기기(교사·전자칠판·학생)를 다시 로그인하게 합니다.
        this.setCfg("secret", randomKey());
        this.sql.exec("DELETE FROM devices");
        this.setCfg("pin_hash", null);
        for (const ws of this.ctx.getWebSockets()) { try { ws.close(4001, "reset"); } catch { /* 이미 닫힘 */ } }
      } else {
        let grade: number, cls: number, size: number;
        try { grade = num(b.grade, 1, 6); cls = num(b.class, 1, 30); size = num(b.size, 1, 60); }
        catch { return fail(400, "bad_class", "학년(1~6)·반(1~30)·인원(1~60)을 확인하세요"); }
        this.setCfg("grade", grade); this.setCfg("class", cls); this.setCfg("size", size);
        this.setCfg("secret", randomKey());
      }
      this.setCfg("login_id", loginId);
      this.setCfg("teacher_name", String(b.name ?? "").trim().slice(0, 20) || "선생님");
      this.setCfg("pw_hash", await hashPassword(pw));
      return json({ ok: true, reset });
    }
    if (path === "/login" && method === "POST") {
      if (!this.configured()) return fail(409, "not_configured", "아직 설치 설정을 하지 않았습니다");
      if (Date.now() < this.loginFails.until) return fail(429, "locked", "잠시 뒤에 다시 시도하세요");
      const b = await body();
      const ok = String(b.login_id ?? "") === this.cfg("login_id") && await checkPassword(String(b.password ?? ""), this.cfg("pw_hash")!);
      if (!ok) {
        if (++this.loginFails.n >= 5) { this.loginFails = { n: 0, until: Date.now() + 60_000 }; }
        return fail(401, "bad_login", "아이디 또는 비밀번호가 맞지 않습니다");
      }
      this.loginFails.n = 0;
      const t = await this.tokenFor({ sub: this.cfg("login_id")!, name: this.cfg("teacher_name") ?? "", role: "teacher" });
      return json({ ...t, role: "teacher" });
    }

    const ip = req.headers.get("cf-connecting-ip") || "local";
    if (path === "/student/class" && method === "GET") {
      if (!this.configured()) return fail(409, "not_configured", "아직 설치 설정을 하지 않았습니다");
      if (this.codeLocked(ip)) return fail(429, "locked", "코드를 여러 번 틀렸습니다. 10분 뒤에 다시 해 보세요");
      if (!this.codeMatches(url.searchParams.get("code"))) { this.codeFailed(ip); return fail(404, "bad_code", "학급 코드가 맞지 않습니다"); }
      const k = this.klass();
      return json({ ok: true, grade: k.grade, class: k.class, size: k.size });
    }
    if (path === "/student/join" && method === "POST") {
      if (!this.configured()) return fail(409, "not_configured", "아직 설치 설정을 하지 않았습니다");
      if (this.codeLocked(ip)) return fail(429, "locked", "코드를 여러 번 틀렸습니다. 10분 뒤에 다시 해 보세요");
      const b = await body();
      const k = this.klass();
      const n = Number(b.num);
      if (!this.codeMatches(b.code)) { this.codeFailed(ip); return fail(403, "bad_code", "학급 코드가 맞지 않습니다"); }
      if (!Number.isInteger(n) || n < 1 || n > k.size) return fail(400, "bad_num", "번호를 확인하세요");
      const t = await this.tokenFor({ sub: `s${n}`, name: `${n}번`, role: "student", num: n,
        cv: Number(this.cfg("code_ver") || 1) }, STUDENT_TOKEN_HOURS / 24);
      return json({ ...t, role: "student", num: n, grade: k.grade, class: k.class });
    }

    const th = /^\/thumbs\/(\d+)$/.exec(path);
    if (th && method === "GET") {
      const pid = Number(th[1]);
      if (!this.configured() || url.searchParams.get("s") !== await shortSig(this.cfg("secret")!, `thumb:${pid}`)) return new Response("not found", { status: 404 });
      const r = this.sql.exec<{ data: ArrayBuffer }>("SELECT data FROM page_thumbs WHERE page_id = ?", pid).toArray()[0]
        ?? await this.archive.thumb(pid).then((d) => (d ? { data: d } : undefined));          // 확장판: R2 로 옮긴 수업
      if (!r) return new Response("not found", { status: 404 });
      return new Response(r.data, { headers: { "content-type": sniffImage(new Uint8Array(r.data)) ?? "image/webp",
        "cache-control": "private, max-age=31536000, immutable", "x-content-type-options": "nosniff" } });
    }
    const file = /^\/files\/(\d+)$/.exec(path);
    if (file && method === "GET") return this.media.serve(Number(file[1]), url.searchParams.get("k"), url.searchParams.get("t") === "1");

    if (path === "/auth/device/token" && method === "POST") {
      if (!this.configured()) return fail(409, "not_configured", "아직 설치 설정을 하지 않았습니다");
      const key = String((await body()).key ?? "");
      const row = key.length >= 20 && key.length <= 100 ? this.sql.exec<{ id: number; label: string; last_seen: number }>(
        "SELECT id, label, last_seen FROM devices WHERE key_hash = ?", await sha256(key)).toArray()[0] : undefined;
      if (!row) return fail(401, "device_revoked", "등록이 해제되었거나 만료된 기기입니다");
      if (Date.now() - row.last_seen > 3600e3) this.sql.exec("UPDATE devices SET last_seen = ? WHERE id = ?", Date.now(), row.id);
      return json({ ...(await this.deviceToken(row)), device: this.devPublic(row) });
    }

    const u = await this.user(req);
    if (!u) return fail(401, "not_logged_in", "로그인이 필요합니다");
    if (u.dev && !this.device(u.dev)) return fail(401, "device_revoked", "등록이 해제된 기기입니다");
    const teacher = u.role === "teacher";
    if (!teacher) return fail(403, "forbidden", "교사만 사용할 수 있습니다");
    const k = this.klass();

    if (path === "/me" && method === "GET") return json({ me: u, klass: k });
    const elev = this.elevated(u);
    const needPin = () => fail(403, "pin_required", "PIN 이 필요합니다");
    const loggedIn = () => fail(403, "forbidden", "교사 로그인이 필요합니다");

    if (path === "/classes" && method === "GET") {
      if (!elev) return needPin();
      return json({ school: 1, classes: [{ grade: k.grade, class: k.class }] });
    }
    if (path === "/auth/pin-status" && method === "GET") {
      if (u.dev) return loggedIn();
      return json({ has_pin: !!this.cfg("pin_hash") });
    }
    if (path === "/auth/device" && method === "POST") {
      // 교사가 로그인한 기기에서: 이 기기를 전자칠판으로 등록(기기 키를 받음)
      if (u.dev) return loggedIn();
      const b = await body();
      const pin = b.pin == null || b.pin === "" ? null : String(b.pin);
      if (pin !== null && !PIN_RE.test(pin)) return fail(400, "bad_pin", "PIN 은 숫자 4~6자리입니다");
      if (pin) this.setCfg("pin_hash", await hashPassword(pin));
      else if (!this.cfg("pin_hash")) return fail(400, "pin_required", "처음 등록할 때는 PIN 을 정해야 합니다");
      const n = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM devices").one().n;
      if (n >= 20) return fail(400, "too_many", "등록된 전자칠판이 너무 많습니다. 쓰지 않는 기기를 해제하세요");
      const key = randomKey(32);
      const label = `전자칠판 ${k.grade}-${k.class}`;
      const id = this.sql.exec<{ id: number }>("INSERT INTO devices (key_hash, label, created_at, last_seen) VALUES (?, ?, ?, ?) RETURNING id",
        await sha256(key), label, Date.now(), Date.now()).one().id;
      const d = { id, label };
      return json({ key, device: this.devPublic(d), ...(await this.deviceToken(d)) });
    }
    if (path === "/auth/pin" && method === "POST") {
      // 등록 전자칠판에서 PIN 을 넣으면 10분 동안 교사 권한 토큰
      if (!u.dev) return fail(400, "not_device", "등록된 전자칠판에서만 사용합니다");
      const d = this.device(u.dev)!;
      const f = this.pinFails.get(d.id) ?? { n: 0, until: 0 };
      if (Date.now() < f.until) return fail(429, "pin_locked", `PIN 을 여러 번 틀렸습니다. ${Math.ceil((f.until - Date.now()) / 60_000)}분 뒤에 다시 시도하세요`);
      const pin = String((await body()).pin ?? "");
      const ok = PIN_RE.test(pin) && !!this.cfg("pin_hash") && await checkPassword(pin, this.cfg("pin_hash")!);
      if (!ok) {
        f.n++;
        this.pinFails.set(d.id, f.n >= PIN_MAX_FAILS ? { n: 0, until: Date.now() + PIN_LOCK_MS } : f);
        return fail(403, "pin_wrong", "PIN 이 맞지 않습니다");
      }
      this.pinFails.delete(d.id);
      const until = Math.floor(Date.now() / 1000) + PIN_TTL_S;
      return json({ ...(await this.deviceToken(d, until)), pin_until: until });
    }
    if (path === "/auth/device" && method === "PATCH") {
      // 학급이 하나뿐이라 옮길 곳이 없습니다(같은 학급으로 다시 고르면 그대로).
      if (!u.dev || !elev) return needPin();
      const d = this.device(u.dev)!;
      return json({ ...(await this.deviceToken(d, u.pin ?? undefined)), device: this.devPublic(d) });
    }
    if (path === "/auth/device" && method === "DELETE") {
      if (!u.dev || !elev) return needPin();
      this.sql.exec("DELETE FROM devices WHERE id = ?", u.dev);
      return json({ ok: true });
    }
    if (path === "/auth/devices" && method === "GET") {
      if (u.dev) return loggedIn();
      const kst = (t: number) => new Date(t + 9 * 3600e3).toISOString().slice(0, 16).replace("T", " ");
      const devices = this.sql.exec<{ id: number; label: string; created_at: number; last_seen: number }>(
        "SELECT id, label, created_at, last_seen FROM devices ORDER BY id").toArray()
        .map((r) => ({ id: r.id, label: r.label, created_at: kst(r.created_at), last_seen: kst(r.last_seen) }));
      return json({ devices });
    }
    const devDel = /^\/auth\/devices\/(\d+)$/.exec(path);
    if (devDel && method === "DELETE") {
      if (u.dev) return loggedIn();
      const id = Number(devDel[1]);
      if (!this.device(id)) return fail(404, "not_found", "기기를 찾을 수 없습니다");
      this.sql.exec("DELETE FROM devices WHERE id = ?", id);
      this.closeDeviceSockets(id);
      return json({ ok: true });
    }
    if (path === "/class-code" && method === "GET") return json({ code: this.classCode() });
    if (path === "/class-code/rotate" && method === "POST") {
      // 코드를 바꾸면 지금 접속한 학생과 진행 중인 호출이 모두 끝납니다(옛 QR·토큰으로는 못 들어옴).
      this.setCfg("class_code", this.newCode());
      this.setCfg("code_ver", Number(this.cfg("code_ver") || 1) + 1);
      for (const g of this.openGrants()) this.endGrant(g, "revoked", "code_changed");
      for (const ws of this.ctx.getWebSockets()) {
        if (this.att(ws)?.role === "student") { try { ws.close(4001, "code_changed"); } catch { /* 이미 닫힘 */ } }
      }
      this.broadcastCalls();
      return json({ code: this.classCode() });
    }
    if (path === "/roster" && method === "GET") {
      // 서버에는 번호만 둡니다. 이름은 붙이지 않습니다.
      return json({ seats: Array.from({ length: k.size }, (_, i) => ({ seat: i + 1, name: "", status: "active" })) });
    }
    if (path === "/arrangements" && method === "GET") {
      const kind = url.searchParams.get("kind") ?? "";
      const items = this.sql.exec<{ id: number; kind: string; name: string; config: string | null; result: string; created_at: number }>(
        "SELECT id, kind, name, config, result, created_at FROM arrangements WHERE kind = ? ORDER BY id DESC LIMIT 30", kind).toArray()
        .map((r) => ({ ...r, config: r.config ? JSON.parse(r.config) : {}, result: JSON.parse(r.result),
          created_at: new Date(r.created_at + 9 * 3600e3).toISOString().slice(0, 16).replace("T", " ") }));
      return json({ items });
    }
    if (path === "/arrangements" && method === "POST") {
      const b = await body();
      if (!["pick", "groups", "seating"].includes(String(b.kind))) return fail(400, "bad_kind", "종류가 맞지 않습니다");
      const result = JSON.stringify(b.result ?? null);
      if (result.length > 50_000) return fail(400, "too_big", "결과가 너무 큽니다");
      this.sql.exec("INSERT INTO arrangements (kind, name, config, result, created_at) VALUES (?, ?, ?, ?, ?)",
        String(b.kind), String(b.name ?? "").slice(0, 50), JSON.stringify(b.config ?? {}), result, Date.now());
      return json({ ok: true });
    }
    const del = /^\/arrangements\/(\d+)$/.exec(path);
    if (del && method === "DELETE") {
      if (!elev) return needPin();
      this.sql.exec("DELETE FROM arrangements WHERE id = ?", Number(del[1]));
      return json({ ok: true });
    }
    /* 시험용(로컬 .dev.vars 의 DEV_TEST=1 일 때만): 수업 날짜 바꾸기, 보관 바로 돌리기 */
    if (path.startsWith("/_test/") && (this.env as Record<string, unknown>).DEV_TEST === "1") {
      const b = await body();
      if (path === "/_test/age") { this.sql.exec("UPDATE sessions SET day = ? WHERE id = ?", String(b.day), Number(b.id)); return json({ ok: true }); }
      if (path === "/_test/archive") {
        for (const ps of this.pages.values()) if (ps.seq > ps.saved_seq) this.savePage(ps);
        const cutoff = new Date(Date.now() + 9 * 3600e3 - ARCHIVE_AFTER_DAYS * 86400e3).toISOString().slice(0, 10);
        const r = await this.archive.archiveOne(cutoff, this.room()?.session ?? null, R2_CAP - this.media.usage("r2") - this.archive.totalBytes());
        if (r === "done") for (const [id, ps] of this.pages) if (ps.session_id !== this.room()?.session) this.pages.delete(id);
        return json({ ok: true, result: r });
      }
      return fail(404, "not_found", "없는 시험 요청");
    }

    /* 백업 내려받기·되살리기(기본판·확장판) */
    if (path.startsWith("/backup/")) {
      if (path === "/backup/part" && method === "GET") {
        if (!elev) return needPin();
        return json(await this.backup.part(url.searchParams.get("cursor"), url.searchParams.get("media") === "1", SERVER_VERSION, this.r2 ? "storage" : "basic"));
      }
      if (u.dev) return loggedIn();                     // 되살리기는 교사 로그인(비밀번호 확인)으로만
      if (path === "/backup/restore/begin" && method === "POST") {
        const b = await body();
        if (!(await checkPassword(String(b.password ?? ""), this.cfg("pw_hash")!))) return fail(403, "bad_password", "비밀번호가 맞지 않습니다");
        const meta = (b.meta ?? {}) as Json;
        if (meta.t !== "meta" || Number(meta.v) !== BACKUP_VERSION) return fail(400, "bad_backup", "classboard 백업 파일이 아니거나 읽을 수 없는 판입니다");
        await this.backup.wipe();
        this.pages.clear();
        this.setCfg("restoring", Date.now());
        return json({ ok: true });
      }
      if (!this.cfg("restoring")) return fail(409, "not_restoring", "되살리기를 처음부터 다시 시작하세요");
      if (path === "/backup/restore/rows" && method === "POST") {
        if (Number(req.headers.get("content-length") ?? 0) > 16 * 1024 * 1024) return fail(413, "too_large", "한 번에 보내는 양이 너무 큽니다");
        const b = await body();
        return json({ ok: true, ...(await this.backup.rows(Array.isArray(b.lines) ? (b.lines as Json[]) : [])) });
      }
      if (path === "/backup/restore/end" && method === "POST") {
        this.setCfg("restoring", null);
        this.pages.clear();
        for (const ws of this.ctx.getWebSockets()) { try { ws.close(1012, "restored"); } catch { /* 이미 닫힘 */ } }   // 다시 접속하며 새 내용을 받음
        return json({ ok: true });
      }
      return fail(404, "not_found", "없는 요청입니다");
    }

    /* 진도표·차시 자료 */
    if (path.startsWith("/plan/")) {
      try { return await this.planRest(req, path, url, elev); } catch (e) {
        if (e instanceof PlanError) return fail(e.status, e.code, e.message);
        throw e;
      }
    }

    /* 교시 시각·학급 시간표 */
    if (path === "/settings/neis" && method === "GET") {
      const key = this.cfg("neis_key");
      const last = this.cfg("neis_last");
      return json({ on: !!this.neisCfg(), school_name: this.cfg("neis_school_name") ?? "", kind: this.cfg("neis_kind") ?? "",
        office: this.cfg("neis_office") ?? "", school: this.cfg("neis_school") ?? "", key_hint: key ? `••••${key.slice(-4)}` : "",
        last: last ? JSON.parse(last) : null, next: Number(this.cfg("neis_next") || 0) || null });
    }
    if (path === "/settings/neis/schools" && method === "GET") {
      if (!elev) return needPin();
      const name = (url.searchParams.get("name") ?? "").trim();
      if (name.length < 2) return fail(400, "short", "학교 이름을 두 글자 이상 넣으세요");
      const base = String((this.env as Record<string, unknown>).NEIS_BASE || "https://open.neis.go.kr/hub");
      try { return json({ schools: await neisSchools(base, url.searchParams.get("key") || this.cfg("neis_key") || "", name.slice(0, 40)) }); }
      catch (e) { if (e instanceof PlanError) return fail(e.status, e.code, e.message); throw e; }
    }
    if (path === "/settings/neis" && method === "PUT") {
      if (!elev) return needPin();
      const b = await body();
      const key = String(b.key ?? "").trim() || this.cfg("neis_key") || "";
      const office = String(b.office ?? "").trim(), school = String(b.school ?? "").trim(), kind = String(b.kind ?? "초등학교");
      if (!/^[A-Za-z0-9]{10,64}$/.test(key)) return fail(400, "bad_key", "인증키를 확인하세요(나이스 교육정보 개방 포털에서 받은 영문·숫자)");
      if (!/^[A-Z]\d{2}$/.test(office) || !/^\d{7}$/.test(school)) return fail(400, "bad_school", "학교를 검색해서 고르세요");
      if (!(kind in NEIS_TT)) return fail(400, "bad_kind", "초·중·고등학교만 받을 수 있습니다");
      // 인증키가 맞는지 학교 정보로 한 번 확인
      const base = String((this.env as Record<string, unknown>).NEIS_BASE || "https://open.neis.go.kr/hub");
      try {
        const rows = await neisCall(base, "schoolInfo", { KEY: key, ATPT_OFCDC_SC_CODE: office, SD_SCHUL_CODE: school }, 1);
        if (!rows.length) return fail(400, "bad_school", "나이스에서 그 학교를 찾지 못했습니다");
      } catch (e) { if (e instanceof PlanError) return fail(400, "bad_key", e.message); throw e; }
      this.setCfg("neis_key", key); this.setCfg("neis_office", office); this.setCfg("neis_school", school);
      this.setCfg("neis_kind", kind); this.setCfg("neis_school_name", String(b.school_name ?? "").slice(0, 60));
      this.setCfg("neis_next", this.neisNextAt());
      let sync: unknown = null;
      try { sync = await this.neisSync({ force: true }); } catch (e) { sync = { error: (e as Error).message }; }
      await this.scheduleAlarm();
      return json({ ok: true, sync });
    }
    if (path === "/settings/neis" && method === "DELETE") {
      if (!elev) return needPin();
      for (const k of ["neis_key", "neis_office", "neis_school", "neis_kind", "neis_school_name", "neis_next", "neis_last"]) this.setCfg(k, null);
      return json({ ok: true });
    }
    if (path === "/settings/bells" && method === "GET") {
      const rows = this.bells();
      return json({ default: !rows.length, bells: normalize(rows).map(([period, start, end]) => ({ period, start, end })),
        now_period: currentPeriod(rows, kstNow().minutes) });
    }
    if (path === "/settings/bells" && method === "PUT") {
      if (!elev) return needPin();
      const list = (await body()).bells;
      if (!Array.isArray(list) || list.length < 1 || list.length > 9) return fail(400, "bad_bells", "교시는 1~9개입니다");
      const T = /^([01]\d|2[0-3]):[0-5]\d$/;
      const rows: Bell[] = [];
      for (const b of list as Json[]) {
        const p = Number(b.period), st = String(b.start ?? ""), en = String(b.end ?? "");
        if (!Number.isInteger(p) || p < 1 || p > 9) return fail(400, "bad_period", "교시 번호는 1~9입니다");
        if (!T.test(st) || !T.test(en)) return fail(400, "bad_time", `${p}교시 시각을 확인하세요`);
        if (st >= en) return fail(400, "bad_time", `${p}교시 시작이 끝보다 늦습니다`);
        rows.push([p, st, en]);
      }
      if (new Set(rows.map((r) => r[0])).size !== rows.length) return fail(400, "dup_period", "같은 교시가 두 번 있습니다");
      const sorted = [...rows].sort((a, b) => (a[1] < b[1] ? -1 : 1));
      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i][1] < sorted[i - 1][2]) return fail(400, "overlap", `${sorted[i - 1][0]}교시와 ${sorted[i][0]}교시 시간이 겹칩니다`);
        if (sorted[i][0] < sorted[i - 1][0]) return fail(400, "order", "교시 번호와 시각 순서가 맞지 않습니다");
      }
      this.sql.exec("DELETE FROM bells");
      for (const [p, st, en] of rows) this.sql.exec("INSERT INTO bells (period, start, end_) VALUES (?, ?, ?)", p, st, en);
      await this.scheduleAlarm();
      return json({ ok: true });
    }
    if (path === "/settings/timetable" && method === "GET") {
      const slots = this.sql.exec<{ weekday: number; period: number; subject: string }>("SELECT weekday, period, subject FROM timetable").toArray();
      return json({ slots });
    }
    if (path === "/settings/timetable" && method === "PUT") {
      if (!elev) return needPin();
      const slots = (await body()).slots;
      if (!Array.isArray(slots) || slots.length > 45) return fail(400, "bad_slots", "시간표가 맞지 않습니다");
      this.sql.exec("DELETE FROM timetable");
      for (const x of slots as Json[]) {
        const w = Number(x.weekday), p = Number(x.period), sub = String(x.subject ?? "").trim().slice(0, 30);
        if (!sub || !Number.isInteger(w) || w < 1 || w > 5 || !Number.isInteger(p) || p < 1 || p > 9) continue;
        this.sql.exec("INSERT OR REPLACE INTO timetable (weekday, period, subject) VALUES (?, ?, ?)", w, p, sub);
      }
      // 오늘 아직 과목이 비어 있는 수업에는 바로 붙임
      const today = kstNow().day;
      for (const r of this.sql.exec<{ id: number; period_from: number }>(
        "SELECT id, period_from FROM sessions WHERE day = ? AND subject = '' AND deleted = 0", today).toArray()) {
        const sub = this.subjectFor(today, r.period_from);
        if (sub) this.sql.exec("UPDATE sessions SET subject = ? WHERE id = ?", sub, r.id);
      }
      return json({ ok: true });
    }

    /* 자료(사진·PDF): 변환은 올리는 기기에서, 서버는 보관만 */
    if (path === "/media/recent" && method === "GET") return json(this.media.recent());
    if (path === "/media/find" && method === "GET") {
      const sha = url.searchParams.get("sha") ?? "", kind = url.searchParams.get("kind") ?? "";
      return json(/^[0-9a-f]{64}$/.test(sha) ? (this.media.find(sha, kind) ?? { found: false }) : { found: false });
    }
    if (path === "/media/upload" && method === "POST") {
      const n = (k: string) => Number(url.searchParams.get(k) ?? NaN);
      const len = Number(req.headers.get("content-length") ?? 0);
      if (len > 9 * 1024 * 1024) return fail(413, "too_large", "그림이 너무 큽니다");
      const bodyBytes = new Uint8Array(await req.arrayBuffer());
      try {
        return json(await this.media.put({
          set: n("set") || 0, i: n("i"), n: n("n"), kind: url.searchParams.get("kind") ?? "", name: url.searchParams.get("name") ?? "",
          sha: url.searchParams.get("sha") ?? "", w: n("w"), h: n("h"), thumbLen: Number(req.headers.get("x-thumb-len") ?? 0),
        }, bodyBytes));
      } catch (e) {
        if (e instanceof MediaError) return fail(e.status, e.code, e.message);
        throw e;
      }
    }
    const mset = /^\/media\/(\d+)\/set$/.exec(path);
    if (mset && method === "GET") {
      const a = this.media.get(Number(mset[1]));
      if (!a || !a.done) return fail(404, "not_found", "자료가 없습니다");
      this.media.touch([a.set_id]);
      return json({ kind: a.kind, name: a.name ?? "", items: this.media.setOf(a.set_id).map((x) => ({ asset: x.id, w: x.w, h: x.h, page: x.page_index,
        url: `/eboard-api/files/${x.id}?k=${x.key}`, thumb: `/eboard-api/files/${x.id}?k=${x.key}${x.thumb_mime ? "&t=1" : ""}` })) });
    }
    const mdel = /^\/media\/(\d+)$/.exec(path);
    if (mdel && method === "DELETE") {
      if (!elev) return needPin();
      const a = this.media.get(Number(mdel[1]));
      if (!a) return fail(404, "not_found", "자료가 없습니다");
      await this.media.deleteSet(a.set_id);
      return json({ ok: true, usage: this.media.activeUsage() });
    }
    const snap = /^\/pages\/(\d+)\/snapshot$/.exec(path);
    if (snap && method === "PUT") {
      // 칠판 기기가 페이지 미리보기 그림을 올림(기록 목록용). 큰 그림은 받지 않고 미리보기만 보관.
      const pid = Number(snap[1]);
      if (!this.sql.exec("SELECT 1 FROM pages WHERE id = ?", pid).toArray().length) return fail(404, "not_found", "페이지가 없습니다");
      const b = await body();
      const seq = Number(b.seq);
      const m = /^data:image\/(?:webp|jpeg|png);base64,([A-Za-z0-9+/=]+)$/.exec(String(b.thumb ?? ""));
      if (!Number.isInteger(seq) || seq < 0 || !m) return fail(400, "bad_image", "미리보기 그림이 아닙니다");
      const raw = Uint8Array.from(atob(m[1]), (c) => c.charCodeAt(0));
      if (raw.length > MAX_THUMB || !sniffImage(raw)) return fail(400, "bad_image", "미리보기 그림이 아니거나 너무 큽니다");
      const old = this.sql.exec<{ seq: number }>("SELECT seq FROM page_thumbs WHERE page_id = ?", pid).toArray()[0];
      if (old && old.seq > seq) return json({ ok: true, skipped: true });
      this.sql.exec("INSERT INTO page_thumbs (page_id, seq, data) VALUES (?, ?, ?) ON CONFLICT(page_id) DO UPDATE SET seq = excluded.seq, data = excluded.data",
        pid, seq, raw);
      return json({ ok: true });
    }

    /* 판서 기록: 교사 로그인 또는 PIN 을 푼 전자칠판 */
    if (path.startsWith("/history/")) {
      if (!elev) return needPin();
      return this.history(req, path, url);
    }
    return fail(404, "not_available", "이 판에서는 아직 지원하지 않는 기능입니다");
  }

  /* ───────────── 진도표 ───────────── */

  private async planRest(req: Request, path: string, url: URL, elev: boolean): Promise<Response> {
    const method = req.method;
    const today = kstNow().day;
    if (method === "GET") {
      if (path === "/plan/week") return json(this.plan.week(url.searchParams.get("date") ?? "", today, !!this.neisCfg()));
      if (path === "/plan/terms") return json(this.plan.terms());
      if (path === "/plan/media") return json(this.plan.mediaList(url.searchParams.get("lkey") ?? ""));
      if (path === "/plan/now") { const s = this.slot(); return json(this.plan.now(s.day, s.period)); }
      return fail(404, "not_found", "없는 요청입니다");
    }
    if (!elev) return fail(403, "pin_required", "PIN 이 필요합니다");
    const body = async () => (await req.json().catch(() => ({}))) as Json;
    if (path === "/plan/upload" && method === "POST") {
      if (Number(req.headers.get("content-length") ?? 0) > 3 * 1024 * 1024) return fail(413, "too_large", "파일 내용이 너무 큽니다");
      const kind = url.searchParams.get("kind"), force = url.searchParams.get("force") === "1";
      if (kind === "timetable") {
        const r = await this.plan.uploadTt(await body(), this.klass(), force);
        this.relabelSessions([today]);
        return json(r);
      }
      const r = await this.plan.uploadPlan(await body(), this.klass(), force, url.searchParams.get("name") ?? "");
      if (this.neisCfg()) {                              // 나이스 인증키가 있으면 시간표를 받아 교시를 맞춤
        try {
          const n = await this.neisSync({ termId: r.term_id, force: true });
          r.neis = { rows: n[0]?.rows ?? 0 };
          const again = n[0] as Record<string, unknown> | undefined;
          if (again && "matched" in again) Object.assign(r, { matched: again.matched, unplaced: again.unplaced, free: again.free, with_tt: again.with_tt, edits: again.edits, edits_dropped: again.edits_dropped });
        } catch (e) { r.neis = { error: (e as Error).message }; }
      }
      this.relabelSessions([today]);
      return json(r);
    }
    if (path === "/plan/neis" && method === "POST") return json({ ok: true, results: await this.neisSync({ force: true }) });
    const slot = /^\/plan\/slot\/(\d+)$/.exec(path);
    if (slot && method === "POST") { this.relabelSessions(this.plan.slotAction(Number(slot[1]), await body())); return json({ ok: true }); }
    if (path === "/plan/swap" && method === "POST") {
      const b = await body();
      this.relabelSessions(this.plan.swap(Number(b.a), Number(b.b)));
      return json({ ok: true });
    }
    const les = /^\/plan\/lesson\/(\d+)$/.exec(path);
    if (les && method === "POST") { this.relabelSessions(this.plan.lessonAction(Number(les[1]), await body())); return json({ ok: true }); }
    if (path === "/plan/media" && method === "POST") return json(this.plan.mediaAdd(await body(), cleanWebUrl));
    const mv = /^\/plan\/media\/(\d+)\/move$/.exec(path);
    if (mv && method === "POST") return json(this.plan.mediaMove(Number(mv[1]), Number((await body()).dir)));
    const md = /^\/plan\/media\/(\d+)$/.exec(path);
    if (md && method === "DELETE") return json(this.plan.mediaDel(Number(md[1])));
    return fail(404, "not_found", "없는 요청입니다");
  }

  /* ───────────── 판서 기록 ───────────── */

  private async thumbUrl(pageId: number, seq: number): Promise<string> {
    return `/eboard-api/thumbs/${pageId}?s=${await shortSig(this.cfg("secret")!, `thumb:${pageId}`)}&v=${seq}`;
  }

  /** 기록에 보일 페이지: 무엇이든 쓴 페이지 또는 자료를 깐 페이지 */
  private static USED = "(p.last_seq > 0 OR p.bg_type IN ('image', 'pdf'))";

  private storage() {
    const db = this.sql.databaseSize;
    return { db, budget: DB_BUDGET, media: this.media.usage("do"),
      r2: this.r2 ? { cap: R2_CAP, media: this.media.usage("r2"), archive: this.archive.totalBytes() } : null };
  }

  private async history(req: Request, path: string, url: URL): Promise<Response> {
    const method = req.method;
    if (path === "/history/sessions" && method === "GET") {
      const day = (k: string, d: string) => (/^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get(k) ?? "") ? url.searchParams.get(k)! : d);
      const end = day("end", kstNow().day), start = day("start", "0000-00-00");
      const rows = this.sql.exec<Row>(
        `SELECT s.*, (SELECT COUNT(*) FROM pages p WHERE p.session_id = s.id AND ${ClassRoom.USED}) AS used,
           (SELECT p.id FROM pages p JOIN page_thumbs t ON t.page_id = p.id WHERE p.session_id = s.id AND ${ClassRoom.USED} ORDER BY p.page_no LIMIT 1) AS thumb_page,
           (SELECT p.id FROM pages p WHERE p.session_id = s.id AND ${ClassRoom.USED} ORDER BY p.page_no LIMIT 1) AS first_page
         FROM sessions s WHERE s.deleted = 0 AND s.day >= ? AND s.day <= ? ORDER BY s.day DESC, s.period_from`, start, end).toArray() as Json[];
      const sessions = [];
      for (const r of rows) {
        if (!Number(r.used)) continue;                         // 아무것도 쓰지 않은 수업은 숨김
        let tp = r.thumb_page ? Number(r.thumb_page) : 0;
        let tseq = tp ? this.sql.exec<{ seq: number }>("SELECT seq FROM page_thumbs WHERE page_id = ?", tp).one().seq : 0;
        if (!tp && r.archived) { tp = this.archive.thumbsOf(Number(r.id))[0] ?? 0; tseq = 0; }     // 확장판: R2 로 옮긴 수업
        sessions.push({ ...this.sessionMeta(r), pages: Number(r.used), joint: null, first_page: Number(r.first_page) || null,
          started_at: new Date(Number(r.created_at) + 9 * 3600e3).toISOString().slice(11, 16),
          thumb: tp ? await this.thumbUrl(tp, tseq) : null });
      }
      return json({ sessions, storage: this.storage() });
    }
    const one = /^\/history\/sessions\/(\d+)$/.exec(path);
    if (one) {
      const sess = this.getSession(Number(one[1]));
      if (!sess || sess.deleted) return fail(404, "not_found", "기록이 없습니다");
      if (method === "DELETE") {
        if (this.room()?.session === sess.id) return fail(409, "in_use", "지금 칠판에 열려 있는 수업은 지울 수 없습니다. 다른 수업으로 옮긴 뒤 지우세요");
        if (sess.archived) await this.archive.remove(sess.id as number);
        const ids = this.sql.exec<{ id: number }>("SELECT id FROM pages WHERE session_id = ?", sess.id).toArray().map((x) => x.id);
        for (const id of ids) {
          this.sql.exec("DELETE FROM ops WHERE page_id = ?", id);
          this.sql.exec("DELETE FROM page_thumbs WHERE page_id = ?", id);
          this.pages.delete(id);
        }
        this.sql.exec("DELETE FROM pages WHERE session_id = ?", sess.id);
        this.sql.exec("DELETE FROM sessions WHERE id = ?", sess.id);
        return json({ ok: true });
      }
      if (method !== "GET") return fail(405, "method", "지원하지 않는 요청입니다");
      const k = this.klass();
      const rows = this.sql.exec<{ id: number; page_no: number; w: number; h: number; last_seq: number; bg_type: string; tseq: number | null }>(
        `SELECT p.id, p.page_no, p.w, p.h, p.last_seq, p.bg_type, t.seq AS tseq FROM pages p LEFT JOIN page_thumbs t ON t.page_id = p.id
         WHERE p.session_id = ? AND ${ClassRoom.USED} ORDER BY p.page_no`, sess.id).toArray();
      const pages = [];
      const archivedThumbs = sess.archived ? new Set(this.archive.thumbsOf(sess.id as number)) : null;
      for (const p of rows) {
        const hasThumb = p.tseq !== null || !!archivedThumbs?.has(p.id);
        pages.push({ id: p.id, page_no: p.page_no, w: p.w, h: p.h, seq: p.last_seq, bg: p.bg_type === "image" || p.bg_type === "pdf",
          thumb: hasThumb ? await this.thumbUrl(p.id, p.tseq ?? 0) : null, image: null });
      }
      return json({ session: { ...this.sessionMeta(sess), grade: k.grade, class: k.class }, pages });
    }
    const st = /^\/history\/pages\/(\d+)\/(state|ops)$/.exec(path);
    if (st && method === "GET") {
      const pid = Number(st[1]);
      const sid = this.sql.exec<{ s: number }>("SELECT session_id AS s FROM pages WHERE id = ?", pid).toArray()[0]?.s;
      if (sid !== undefined && this.archive.isArchived(sid)) {
        // 확장판: R2 로 옮긴 수업은 보관본에서 읽음(칠판 저장소로 되돌리지 않음)
        const data = await this.archive.load(sid);
        const ap = data?.pages.find((x) => x.id === pid);
        const row = this.sql.exec<PageRow>("SELECT * FROM pages WHERE id = ?", pid).toArray()[0];
        if (!ap || !row) return fail(404, "not_found", "보관한 기록을 찾지 못했습니다");
        const ps = new PageState({ ...row, state_json: ap.state_json, state_seq: ap.state_seq });
        if (ap.state_json) for (const o of JSON.parse(ap.state_json).objs ?? []) ps.objs.set(o.id, o);
        for (const op of ap.ops) if (op.seq > ps.seq) { ps.apply(op.kind, op.obj_id, op.data ? JSON.parse(op.data) : null); ps.seq = op.seq; }
        if (st[2] === "state") return json(ps.toClient());
        const ops = ap.ops.map((o) => ({ s: o.seq, k: o.kind, id: o.obj_id, d: o.data ? JSON.parse(o.data) : null, t: o.ts }));
        const complete = ops.length > 0 && ops[0].s === 1;
        const out = complete ? ops : [...ps.objs.values()].map((o, i) => ({ s: i + 1, k: "add", id: (o as Json).id, d: o, t: 0 }));
        return json({ page: ps.meta(), ops: out, replay: complete });
      }
      const ps = this.getPage(pid);
      if (!ps) return fail(404, "not_found", "페이지가 없습니다");
      if (st[2] === "state") return json(ps.toClient());
      // 판서 재생: 처음부터 모든 동작과 시각. 오래되어 동작 기록을 정리한 페이지는 완성된 판서를 한 번에.
      const ops = this.sql.exec<{ seq: number; kind: string; obj_id: string | null; data: string | null; ts: number }>(
        "SELECT seq, kind, obj_id, data, ts FROM ops WHERE page_id = ? ORDER BY seq", ps.id).toArray()
        .map((o) => ({ s: o.seq, k: o.kind, id: o.obj_id, d: o.data ? JSON.parse(o.data) : null, t: o.ts }));
      const complete = ops.length > 0 && ops[0].s === 1;
      const out = complete ? ops : [...ps.objs.values()].map((o, i) => ({ s: i + 1, k: "add", id: (o as Json).id, d: o, t: 0 }));
      return json({ page: ps.meta(), ops: out, replay: complete });
    }
    return fail(404, "not_found", "없는 기록입니다");
  }

  /* ───────────── WebSocket ───────────── */

  private async acceptSocket(req: Request, url: URL): Promise<Response> {
    if (req.headers.get("Upgrade") !== "websocket") return new Response("websocket only", { status: 426 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);

    const device = url.searchParams.get("device") ?? "";
    let user: TokenPayload | null = null;
    let error: string | null = null;
    if (!this.configured()) error = "not_configured";
    else {
      try { user = this.checkStudentCode(await verify(this.cfg("secret")!, url.searchParams.get("token"))); }
      catch (e) { error = e instanceof TokenError ? (e.message === "expired" ? "not_logged_in" : e.message) : "bad_token"; }
    }
    if (user && !(user.role === "teacher" ? TEACHER_DEVICES.has(device) : device === "student")) error = "bad_device";
    if (user?.dev && !error) {
      if (device !== "display") error = "bad_device";              // 등록 기기 토큰은 전자칠판으로만
      else if (!this.device(user.dev)) error = "device_revoked";   // 해제된 기기는 남은 토큰으로도 못 들어옴
    }

    if (error || !user) {
      server.send(JSON.stringify({ e: "auth-error", d: { error } }));
      server.close(4001, error ?? "auth");
      return new Response(null, { status: 101, webSocket: client });
    }
    const att: Att = { id: randomKey(6), ...(user.dev ? { dev: user.dev } : {}), sub: user.sub, name: user.name ?? "", role: user.role, device, joined: false,
      ...(user.role === "student" ? { num: user.num ?? 0, grant: null } : {}) };
    server.serializeAttachment(att);
    server.send(JSON.stringify({ e: "hello", d: { me: user, device, server_version: SERVER_VERSION, server_ms: Date.now(),
      features: { photo: false, watch: false } } }));
    if (user.role === "student") this.broadcastCalls();
    return new Response(null, { status: 101, webSocket: client });
  }

  private att(ws: WebSocket): Att | null { return ws.deserializeAttachment() as Att | null; }

  private joinedSockets(): WebSocket[] {
    return this.ctx.getWebSockets().filter((ws) => this.att(ws)?.joined);
  }

  private emit(ev: string, d: unknown, except?: WebSocket): void {
    const msg = JSON.stringify({ e: ev, d });
    for (const ws of this.joinedSockets()) {
      if (ws === except) continue;
      try { ws.send(msg); } catch { /* 끊긴 연결 */ }
    }
  }

  private emitPeers(exclude?: WebSocket): void {
    const peers = this.joinedSockets().filter((w) => w !== exclude).map((w) => {
      const a = this.att(w)!;
      return { name: a.name, device: a.device, viewer: false };
    });
    this.emit("room:peers", { peers }, exclude);
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== "string") return;
    let msg: { c?: number; e?: string; d?: unknown };
    try { msg = JSON.parse(raw); } catch { return; }
    const a = this.att(ws);
    if (!a || typeof msg.e !== "string") return;
    let ack: Ack;
    try {
      ack = await this.handle(ws, a, msg.e, (msg.d ?? {}) as Json);
    } catch (e) {
      ack = { ok: false, error: e instanceof OpError ? e.message : "server" };
      if (!(e instanceof OpError)) console.error("handler", msg.e, e);
    }
    if (typeof msg.c === "number") {
      try { ws.send(JSON.stringify({ a: msg.c, d: ack ?? null })); } catch { /* 끊김 */ }
    }
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, "bye"); } catch { /* 이미 닫힘 */ }
    this.emitPeers(ws);
    if (this.att(ws)?.role === "student") this.broadcastCalls(ws);
    if (!this.joinedSockets().some((w) => w !== ws)) this.flushPages(true);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.emitPeers(ws);
  }

  /* ───────────── 학급 방 상태 ───────────── */

  private slot(): { day: string; period: number } {
    const k = kstNow();
    return { day: k.day, period: currentPeriod(this.bells(), k.minutes) };
  }

  private getSession(id: number): Json | null {
    return (this.sql.exec<Row>("SELECT * FROM sessions WHERE id = ? AND deleted = 0", id).toArray()[0] as Json | undefined) ?? null;
  }

  private sessionMeta(s: Json): Json {
    return { id: s.id, date: s.day, period_from: s.period_from, period_to: s.period_to,
      subject: s.subject ?? "", lesson: s.lesson ?? "", label: periodLabel(s.period_from as number, s.period_to as number) };
  }

  private createPage(sessionId: number, bgColor: string | null = this.cfg("class_color")): number {
    const n = this.sql.exec<{ n: number }>("SELECT COALESCE(MAX(page_no), 0) + 1 AS n FROM pages WHERE session_id = ?", sessionId).one().n;
    return this.sql.exec<{ id: number }>(
      "INSERT INTO pages (session_id, page_no, bg_color, updated_at) VALUES (?, ?, ?, ?) RETURNING id",
      sessionId, n, bgColor, Date.now()).one().id;
  }

  /** 학급 시간표의 과목(월~금, 1~9교시) */
  private subjectFor(day: string, period: number): string {
    const wd = new Date(day + "T00:00:00Z").getUTCDay();
    if (wd < 1 || wd > 5 || period < 1 || period > 9) return "";
    return this.sql.exec<{ subject: string }>("SELECT subject FROM timetable WHERE weekday = ? AND period = ?", wd, period).toArray()[0]?.subject ?? "";
  }

  /** 새 수업: 진도표가 있으면 과목·차시 이름을 붙이고 차시 자료를 페이지로 깝니다(없으면 학급 시간표의 과목). */
  private createSession(day: string, period: number): Json {
    const info = this.plan.sessionInfo(day, period);
    const id = this.sql.exec<{ id: number }>(
      "INSERT INTO sessions (day, period_from, period_to, subject, lesson, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
      day, period, period, info?.subject || this.subjectFor(day, period), info?.lesson ?? "", Date.now()).one().id;
    const pages = info?.items.length ? this.plan.pagesFor(info.items, imageMeta, pageSizeFor, cleanWebUrl) : [];
    if (!pages.length) { this.createPage(id); return this.getSession(id)!; }
    let first = 0;
    for (const pg of pages) {
      const pid = this.createPage(id);
      this.sql.exec("UPDATE pages SET w = ?, h = ?, bg_type = ?, bg_meta = ? WHERE id = ?", pg.w, pg.h, pg.bg_type, JSON.stringify(pg.bg_meta), pid);
      first = first || pid;
    }
    this.sql.exec("UPDATE pages SET updated_at = ? WHERE id = ?", Date.now() + 1000, first);   // 첫 자료 페이지가 열리게
    return this.getSession(id)!;
  }

  /** 진도 조정 뒤: 이미 만든 판서(오늘까지)의 과목·차시 이름을 고치고, 열려 있는 칠판에 알림 */
  private relabelSessions(dates: string[]): void {
    const today = kstNow().day;
    const days = [...new Set([...dates, today])].filter((d) => d <= today);
    for (const d of days) {
      for (const r of this.sql.exec<{ id: number; period_from: number; subject: string; lesson: string }>(
        "SELECT id, period_from, subject, lesson FROM sessions WHERE day = ? AND deleted = 0 AND period_from BETWEEN 1 AND 9", d).toArray()) {
        const info = this.plan.sessionInfo(d, r.period_from);
        if (!info || (info.subject === r.subject && info.lesson === r.lesson)) continue;
        this.sql.exec("UPDATE sessions SET subject = ?, lesson = ? WHERE id = ?", info.subject, info.lesson, r.id);
        if (this.room()?.session === r.id) this.emit("session:meta", { session: this.sessionMeta(this.getSession(r.id)!) });
      }
    }
  }

  private resolveSession(day: string, period: number): Json {
    const s = this.sql.exec<Row>(
      "SELECT * FROM sessions WHERE day = ? AND deleted = 0 AND period_from <= ? AND period_to >= ? ORDER BY id DESC LIMIT 1",
      day, period, period).toArray()[0] as Json | undefined;
    return s ?? this.createSession(day, period);
  }

  private ensurePage(sessionId: number): number {
    const r = this.sql.exec<{ id: number }>(
      "SELECT id FROM pages WHERE session_id = ? ORDER BY updated_at DESC, page_no DESC LIMIT 1", sessionId).toArray()[0];
    return r ? r.id : this.createPage(sessionId);
  }

  private room(): { day: string; period: number; session: number; page: number } | null {
    const s = this.cfg("room_session");
    if (!s) return null;
    return { day: this.cfg("room_day")!, period: Number(this.cfg("room_period")), session: Number(s), page: Number(this.cfg("room_page")) };
  }
  private setRoom(r: { day: string; period: number; session: number; page: number }): void {
    this.setCfg("room_day", r.day); this.setCfg("room_period", r.period);
    this.setCfg("room_session", r.session); this.setCfg("room_page", r.page);
  }

  /** 지금 교시에 맞는 방 상태를 보장합니다(없거나 교시가 바뀌었으면 세션을 찾거나 만듦). */
  private currentRoom() {
    const { day, period } = this.slot();
    let r = this.room();
    if (!r || r.day !== day || r.period !== period || !this.getSession(r.session)) {
      const s = this.resolveSession(day, period);
      r = { day, period, session: s.id as number, page: this.ensurePage(s.id as number) };
      this.setRoom(r);
    }
    return r;
  }

  private getPage(id: number): PageState | null {
    const hit = this.pages.get(id);
    if (hit) return hit;
    const row = this.sql.exec<PageRow>("SELECT * FROM pages WHERE id = ?", id).toArray()[0];
    if (!row) return null;
    const ps = new PageState(row);
    if (row.state_json) for (const o of JSON.parse(row.state_json).objs ?? []) ps.objs.set(o.id, o);
    for (const op of this.sql.exec<{ seq: number; kind: string; obj_id: string | null; data: string | null }>(
      "SELECT seq, kind, obj_id, data FROM ops WHERE page_id = ? AND seq > ? ORDER BY seq", id, ps.seq)) {
      ps.apply(op.kind, op.obj_id, op.data ? JSON.parse(op.data) : null);
      ps.seq = op.seq;
    }
    if (ps.seq > ps.saved_seq) ps.last_change = Date.now();
    this.pages.set(id, ps);
    return ps;
  }

  private savePage(ps: PageState): void {
    this.sql.exec("UPDATE pages SET state_json = ?, state_seq = ? WHERE id = ?",
      JSON.stringify({ objs: [...ps.objs.values()] }), ps.seq, ps.id);
    ps.saved_seq = ps.seq;
  }

  private flushPages(force = false): void {
    const now = Date.now();
    for (const ps of this.pages.values()) {
      if (ps.seq > ps.saved_seq && (force || ps.seq - ps.saved_seq >= SNAP_EVERY_OPS || now - ps.last_change >= SNAP_IDLE_MS)) {
        this.savePage(ps);
      }
    }
    if (force) this.pages.clear();
  }

  private payload(): Json {
    const r = this.currentRoom();
    const ps = this.getPage(r.page)!;
    const sess = this.getSession(r.session);
    const pages = this.sql.exec<{ id: number; page_no: number }>(
      "SELECT id, page_no FROM pages WHERE session_id = ? ORDER BY page_no", r.session).toArray();
    return { session_id: r.session, session: sess ? this.sessionMeta(sess) : null, pages, page: ps.toClient() };
  }

  private switchTo(sessionId: number, ev = "page:current", extra: Json = {}): void {
    const r = this.currentRoom();
    this.setRoom({ ...r, session: sessionId, page: this.ensurePage(sessionId) });
    this.emit(ev, { ...this.payload(), ...extra });
  }

  /* ───────────── 알람: 교시 넘김 + 상태 저장 ───────────── */

  private async scheduleAlarm(): Promise<void> {
    const dirty = [...this.pages.values()].some((p) => p.seq > p.saved_seq);
    const live = this.joinedSockets().length > 0;
    let at = live ? nextBoundary(this.bells()) : Infinity;
    if (dirty) at = Math.min(at, Date.now() + SNAP_IDLE_MS + 1000);
    for (const g of this.openGrants()) at = Math.min(at, g.expires + 500);
    if (this.neisCfg()) at = Math.min(at, Number(this.cfg("neis_next") || 0) || this.neisNextAt());
    if (at === Infinity) return;
    const cur = await this.ctx.storage.getAlarm();
    if (cur === null || cur > at || cur < Date.now()) await this.ctx.storage.setAlarm(at);
  }

  async alarm(): Promise<void> {
    this.flushPages();
    if (Math.random() < (this.r2 ? 0.25 : 0.05)) {       // 가끔만: 올리다 끊긴 자료, 오래된 판서 기록(확장판은 R2 로 옮김)
      await this.media.sweep();
      for (const ps of this.pages.values()) if (ps.seq > ps.saved_seq) this.savePage(ps);
      let prune = !this.r2;
      if (this.r2) {                                     // 확장판: 지우지 않고 R2 로 옮김. R2 한도에 걸리면 기본판처럼 정리
        const cutoff = new Date(Date.now() + 9 * 3600e3 - ARCHIVE_AFTER_DAYS * 86400e3).toISOString().slice(0, 10);
        const left = R2_CAP - this.media.usage("r2") - this.archive.totalBytes();
        try {
          const r = await this.archive.archiveOne(cutoff, this.room()?.session ?? null, left);
          if (r === "full") prune = true;
          if (r === "done") for (const [id, ps] of this.pages) if (ps.session_id !== this.room()?.session) this.pages.delete(id);   // 옮긴 수업이 메모리에 남지 않게
        } catch { /* 다음에 다시 */ }
      }
      if (prune) {
        this.sql.exec(`DELETE FROM ops WHERE ts < ? AND seq <= (SELECT state_seq FROM pages WHERE pages.id = ops.page_id)`,
          Date.now() - OPS_KEEP_DAYS * 86400e3);
      }
    }
    this.expireGrants();
    if (this.neisCfg() && Date.now() >= Number(this.cfg("neis_next") || 0)) {
      this.setCfg("neis_next", this.neisNextAt());      // 실패해도 내일 다시(나이스가 막혀도 계속 두드리지 않음)
      try { await this.neisSync(); } catch { /* neis_last 에 남김 */ }
    }
    if (this.joinedSockets().length) {
      const prevRoom = this.room();
      const { day, period } = this.slot();
      if (prevRoom && (prevRoom.day !== day || prevRoom.period !== period)) {
        const prev = this.getSession(prevRoom.session);
        const s = this.resolveSession(day, period);
        this.setRoom({ day, period, session: s.id as number, page: this.ensurePage(s.id as number) });
        if (s.id !== prevRoom.session) {
          this.emit("session:rollover", {
            ...this.payload(),
            prev_session_id: prev ? prev.id : null,
            prev_label: prev ? periodLabel(prev.period_from as number, prev.period_to as number) : "",
            can_continue: !!prev && prev.day === day,
          });
        }
      }
    }
    await this.scheduleAlarm();
  }

  /* ───────────── 학생 호출(칠판에 풀기) ─────────────
   * 학생은 평소 칠판 내용을 받지 않습니다. 선생님이 부르고 학생이 '시작하기'를 누른 동안만
   * 방에 들어와 지금 페이지에 직접 씁니다. 자기가 그린 것만 지우거나 고칠 수 있습니다.
   * 호출 상태는 이 객체가 잠들어도 남도록 SQLite 에 둡니다.
   */

  private openGrants(): Grant[] {
    return this.sql.exec<Grant>("SELECT id, num, mode, status, expires, done FROM grants WHERE status IN ('waiting','active') ORDER BY id").toArray();
  }
  private grantById(id: number): Grant | null {
    return this.sql.exec<Grant>("SELECT id, num, mode, status, expires, done FROM grants WHERE id = ?", id).toArray()[0] ?? null;
  }
  private publicGrant(g: Grant): Json {
    const k = this.klass();
    return { id: g.id, seat: g.num, name: "", mode: g.mode, status: g.status, expires: Math.floor(g.expires / 1000),
      done: !!g.done, grade: k.grade, class: k.class, home: false, hand: false };
  }
  private studentSockets(num?: number): WebSocket[] {
    return this.ctx.getWebSockets().filter((w) => { const a = this.att(w); return a?.role === "student" && (num === undefined || a.num === num); });
  }
  private toStudent(num: number, ev: string, d: unknown): void {
    const msg = JSON.stringify({ e: ev, d });
    for (const w of this.studentSockets(num)) { try { w.send(msg); } catch { /* 끊김 */ } }
  }
  private callState(except?: WebSocket): Json {
    const k = this.klass();
    const nums = new Set(this.studentSockets().filter((w) => w !== except).map((w) => this.att(w)!.num));
    return { grants: this.openGrants().map((g) => this.publicGrant(g)), online: [...nums].map((n) => `${k.grade}-${k.class}-${n}`) };
  }
  /** 교사 기기들에게만 호출 상태를 알립니다(풀이 중인 학생에게는 보내지 않음). */
  private broadcastCalls(except?: WebSocket): void {
    const msg = JSON.stringify({ e: "call:grants", d: this.callState(except) });
    for (const w of this.joinedSockets()) {
      if (w === except || this.att(w)?.role !== "teacher") continue;
      try { w.send(msg); } catch { /* 끊김 */ }
    }
  }
  private endGrant(g: Grant, status: string, reason: string): void {
    this.sql.exec("UPDATE grants SET status = ? WHERE id = ?", status, g.id);
    for (const w of this.studentSockets(g.num)) {
      const a = this.att(w)!;
      if (a.grant === g.id) { a.grant = null; a.joined = false; w.serializeAttachment(a); }
    }
    this.toStudent(g.num, "call:ended", { id: g.id, status, reason });
    this.broadcastCalls();
    this.emitPeers();
  }
  private expireGrants(): void {
    const now = Date.now();
    for (const g of this.openGrants()) if (g.expires < now) this.endGrant(g, "expired", "timeout");
  }
  /** 지금 칠판에 풀고 있는 학생의 호출(없으면 null) */
  private activeSolve(a: Att): Grant | null {
    if (a.role !== "student" || !a.grant) return null;
    const g = this.grantById(a.grant);
    return g && g.status === "active" && g.mode === "solve" && g.num === a.num && g.expires > Date.now() ? g : null;
  }
  /** 이 객체를 마지막으로 그리거나 고친 사람 */
  private lastAuthor(pageId: number, objId: string): string | null {
    return this.sql.exec<{ author: string | null }>(
      "SELECT author FROM ops WHERE page_id = ? AND obj_id = ? AND kind IN ('add','update') ORDER BY seq DESC LIMIT 1",
      pageId, objId).toArray()[0]?.author ?? null;
  }

  private async handleCall(ws: WebSocket, a: Att, ev: string, d: Json): Promise<Ack> {
    const now = Date.now();
    if (a.role === "teacher") {
      this.requireTeacherInRoom(a);
      if (ev === "call:list") return { ok: true, ...this.callState() };
      if (ev === "call:invite") {
        const num = Number(d.seat);
        const k = this.klass();
        if (d.mode !== "solve") return { ok: false, error: "not_available" };
        if (!Number.isInteger(num) || num < 1 || num > k.size) return { ok: false, error: "no_student" };
        const open = this.openGrants();
        if (open.some((g) => g.num === num)) return { ok: false, error: "already_called" };
        if (open.length >= MAX_OPEN) return { ok: false, error: "too_many" };
        const id = this.sql.exec<{ id: number }>(
          "INSERT INTO grants (num, mode, status, expires, created_at) VALUES (?, 'solve', 'waiting', ?, ?) RETURNING id",
          num, now + WAIT_MS, now).one().id;
        const g = this.grantById(id)!;
        this.toStudent(num, "call:invite", { ...this.publicGrant(g), teacher: this.cfg("teacher_name") ?? "" });
        this.broadcastCalls();
        await this.scheduleAlarm();
        return { ok: true, id, online: this.studentSockets(num).length > 0 };
      }
      const g = this.grantById(Number(d.id));
      if (!g || !OPEN.includes(g.status)) return { ok: false, error: "no_grant" };
      if (ev === "call:end") { this.endGrant(g, g.status === "waiting" ? "revoked" : "done", "teacher"); return { ok: true }; }
      if (ev === "call:extend") {
        this.sql.exec("UPDATE grants SET expires = ? WHERE id = ?", Math.max(g.expires, now) + 10 * 60_000, g.id);
        this.broadcastCalls();
        await this.scheduleAlarm();
        return { ok: true };
      }
      return { ok: false, error: "not_available" };
    }

    // 학생
    if (ev === "call:mine") {
      return { ok: true, grants: this.openGrants().filter((g) => g.num === a.num)
        .map((g) => ({ ...this.publicGrant(g), teacher: this.cfg("teacher_name") ?? "" })) };
    }
    const g = this.grantById(Number(d.id));
    if (!g || !OPEN.includes(g.status) || g.num !== a.num) return { ok: false, error: "no_grant" };
    if (ev === "call:accept") {
      if (g.status === "waiting") {
        this.sql.exec("UPDATE grants SET status = 'active', expires = ? WHERE id = ?", now + ACTIVE_MS, g.id);
      }
      a.joined = true; a.grant = g.id;
      ws.serializeAttachment(a);
      this.broadcastCalls();
      this.emitPeers();
      await this.scheduleAlarm();
      return { ok: true, grant: this.publicGrant(this.grantById(g.id)!), ...this.payload() };
    }
    if (ev === "call:decline") { this.endGrant(g, "done", "student"); return { ok: true }; }
    if (ev === "call:done") {
      this.sql.exec("UPDATE grants SET done = ? WHERE id = ?", g.done ? 0 : 1, g.id);
      this.broadcastCalls();
      return { ok: true, done: !g.done };
    }
    return { ok: false, error: "not_available" };
  }

  /* ───────────── 이벤트 처리 ───────────── */

  private requireTeacherInRoom(a: Att): void {
    if (a.role !== "teacher") throw new OpError("forbidden");
    if (!a.joined) throw new OpError("no_room");
  }

  private sessionPage(pageId: unknown): PageState {
    const id = Number(pageId);
    const ps = Number.isInteger(id) ? this.getPage(id) : null;
    if (!ps || ps.session_id !== this.currentRoom().session) throw new OpError("bad_page");
    return ps;
  }

  private async handle(ws: WebSocket, a: Att, ev: string, d: Json): Promise<Ack> {
    switch (ev) {
      case "ping:echo":
        return { client_ms: d.client_ms, server_ms: Date.now() };

      case "room:join": {
        if (a.role !== "teacher") return { ok: false, error: "forbidden" };
        const k = this.klass();
        if (Number(d.grade) !== k.grade || Number(d.class) !== k.class) return { ok: false, error: "bad_class" };
        a.joined = true;
        ws.serializeAttachment(a);
        const p = this.payload();
        this.emitPeers();
        await this.scheduleAlarm();
        return { ok: true, room: "class", grade: k.grade, class: k.class, ...p, joint_invite: null, joint_host: false };
      }

      case "session:new": {
        this.requireTeacherInRoom(a);
        const { day, period } = this.slot();
        const s = this.createSession(day, period);
        this.setRoom({ day, period, session: s.id as number, page: this.ensurePage(s.id as number) });
        this.emit("page:current", this.payload());
        return { ok: true };
      }

      case "session:continue": {
        this.requireTeacherInRoom(a);
        const prev = this.getSession(Number(d.prev_session_id));
        if (!prev) return { ok: false, error: "bad_session" };
        const r = this.currentRoom();
        if (r.session !== prev.id) {
          const used = this.sql.exec<{ n: number }>(
            "SELECT COUNT(*) AS n FROM pages WHERE session_id = ? AND (last_seq > 0 OR bg_type NOT IN ('none'))", r.session).one().n;
          if (used) return { ok: false, error: "has_content" };
          this.sql.exec("UPDATE sessions SET deleted = 1 WHERE id = ?", r.session);
        }
        this.sql.exec("UPDATE sessions SET period_to = MAX(period_to, ?) WHERE id = ?", r.period, prev.id);
        this.switchTo(prev.id as number);
        return { ok: true };
      }

      case "session:open": {
        this.requireTeacherInRoom(a);
        if (a.dev) {
          // 등록 전자칠판은 PIN 으로 받은 토큰을 함께 보내야 지난 기록을 엽니다
          let e: TokenPayload | null = null;
          try { e = await verify(this.cfg("secret")!, d.elev_token as string); } catch { e = null; }
          if (!e || e.dev !== a.dev || !this.elevated(e)) return { ok: false, error: "pin_required" };
        }
        const s = this.getSession(Number(d.session_id));
        if (!s) return { ok: false, error: "bad_session" };
        if (!(await this.archive.restore(s.id as number))) return { ok: false, error: "archive_missing" };   // 확장판: 보관한 수업은 되돌려서 엶
        this.switchTo(s.id as number);
        return { ok: true };
      }

      case "page:new": {
        this.requireTeacherInRoom(a);
        const r = this.currentRoom();
        this.setRoom({ ...r, page: this.createPage(r.session) });
        this.emit("page:current", this.payload());
        return { ok: true };
      }

      case "page:import": {
        // 올린 자료 여러 장(PDF 쪽 등)을 새 페이지들로 붙이고 첫 장으로 이동
        this.requireTeacherInRoom(a);
        const ids = d.assets;
        if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_PDF_PAGES) return { ok: false, error: "bad_request" };
        const assets = ids.map((x) => this.media.get(Number(x)));
        if (assets.some((x) => !x || !x.done)) return { ok: false, error: "bad_asset" };
        const r = this.currentRoom();
        let first = 0;
        for (const x of assets) {
          const [w, h] = pageSizeFor(x!.w, x!.h);
          const id = this.createPage(r.session);
          this.sql.exec("UPDATE pages SET w = ?, h = ?, bg_type = ?, bg_meta = ? WHERE id = ?",
            w, h, x!.kind === "pdf" ? "pdf" : "image", JSON.stringify(imageMeta(x!)), id);
          first = first || id;
        }
        this.media.touch(assets.map((x) => x!.set_id));
        this.setRoom({ ...r, page: first });
        this.emit("page:current", this.payload());
        return { ok: true, page_id: first };
      }

      case "page:goto": {
        this.requireTeacherInRoom(a);
        const ps = this.sessionPage(d.page_id);
        this.setRoom({ ...this.currentRoom(), page: ps.id });
        this.sql.exec("UPDATE pages SET updated_at = ? WHERE id = ?", Date.now(), ps.id);
        this.emit("page:current", this.payload());
        return { ok: true };
      }

      case "page:state": {
        if (!a.joined) return { ok: false, error: "no_room" };
        return { ok: true, ...this.payload() };
      }

      case "page:color": {
        this.requireTeacherInRoom(a);
        const ps = this.sessionPage(d.page_id);
        const color = cleanColor(d.color);
        ps.bg_color = color;
        this.sql.exec("UPDATE pages SET bg_color = ? WHERE id = ?", color, ps.id);
        this.setCfg("class_color", color);
        this.emit("page:color", { page_id: ps.id, bg_color: color });
        return { ok: true };
      }

      case "page:bg": {
        this.requireTeacherInRoom(a);
        const ps = this.sessionPage(d.page_id);
        let bg = String(d.bg_type);
        const metaIn = (d.bg_meta ?? {}) as Json;
        let meta: Json;
        if (BG_TYPES.has(bg)) meta = { size: Math.round(num(metaIn.size ?? 80, 20, 400)) };
        else if (bg === "web") meta = { url: cleanWebUrl(metaIn.url) };
        else if (bg === "image" || bg === "pdf") {
          const asset = this.media.get(Number(metaIn.asset));
          if (!asset || !asset.done) return { ok: false, error: "bad_asset" };
          meta = imageMeta(asset);
          bg = asset.kind === "pdf" ? "pdf" : "image";
          this.media.touch([asset.set_id]);
        }
        else if (bg === "video") {
          // 유튜브 또는 이 기기의 동영상 파일(서버에 올리지 않음). 각 기기가 직접 재생하고 진행 기기가 재생·멈춤을 맞춤
          if (metaIn.src === "local") meta = localVideoMeta(metaIn);
          else {
            const yt = String(metaIn.yt ?? "");
            if (!/^[\w-]{11}$/.test(yt)) return { ok: false, error: "not_available" };
            meta = { src: "yt", yt, start: Math.round(num(metaIn.start ?? 0, 0, 86400)) };
          }
        }
        else return { ok: false, error: "not_available" };
        ps.bg_type = bg; ps.bg_meta = meta; ps.play = null;
        this.sql.exec("UPDATE pages SET bg_type = ?, bg_meta = ?, updated_at = ? WHERE id = ?", bg, JSON.stringify(meta), Date.now(), ps.id);
        this.emit("page:bg", { page_id: ps.id, bg_type: bg, bg_meta: meta, bg_url: ps.meta().bg_url, play: null });
        return { ok: true };
      }

      case "video:ctl": {
        this.requireTeacherInRoom(a);
        const ps = this.sessionPage(d.page_id);
        const action = String(d.action);
        if (!["play", "pause", "seek"].includes(action) || ps.bg_type !== "video") return { ok: false, error: "bad_request" };
        const playing = action === "play" || (action === "seek" && !!ps.play?.playing);
        ps.play = { playing, pos: Math.round(num(d.pos ?? 0, 0, 86400) * 100) / 100, at: Date.now() / 1000 };
        this.emit("video:state", { page_id: ps.id, play: ps.meta().play });
        return { ok: true };
      }

      case "op:batch":
        return this.opBatch(a, d);

      case "stroke:live": {
        if (!a.joined || (a.role !== "teacher" && !this.activeSolve(a))) return;
        const pts = d.pts;
        if (!Array.isArray(pts) || pts.length > MAX_LIVE_POINTS * 3) return;
        this.emit("stroke:live", { ...d, from: a.sub + ":" + a.id }, ws);
        return;
      }

      case "tool:event": {
        if (a.role !== "teacher" || !a.joined) return;
        if (JSON.stringify(d).length > 60_000) return;
        this.emit("tool:event", { ...d, from_device: a.device }, ws);
        return;
      }

      default:
        if (ev.startsWith("call:")) return this.handleCall(ws, a, ev, d);
        return { ok: false, error: "not_available" };       // 합반·자료 등은 아직 없음
    }
  }

  private async opBatch(a: Att, d: Json): Promise<Ack> {
    const student = a.role === "student";
    if (student) { if (!a.joined || !this.activeSolve(a)) throw new OpError("forbidden"); }
    else this.requireTeacherInRoom(a);
    const ops = d.ops;
    const cid = String(d.cid ?? "").slice(0, 32);
    const bid = d.bid;
    if (!Array.isArray(ops) || ops.length < 1 || ops.length > MAX_OPS_PER_BATCH) return { ok: false, error: "bad_ops" };
    const ps = this.sessionPage(d.page_id);
    if (student && ps.id !== this.currentRoom().page) return { ok: false, error: "bad_page" };   // 학생은 지금 보이는 페이지에만

    const clean: [string, string | null, Obj | null][] = [];
    for (const op of ops as Json[]) {
      const k = String(op.k);
      if (!KINDS.has(k)) throw new OpError("bad_kind");
      const oid = op.id;
      if (k !== "clear" && (typeof oid !== "string" || !ID_RE.test(oid))) throw new OpError("bad_id");
      const data = k === "add" || k === "update" ? validateObj({ ...((op.d ?? {}) as Json), id: oid }, ps.w, ps.h) : null;
      clean.push([k, k === "clear" ? null : (oid as string), data]);
    }

    if (student) {                                        // 학생: 자기 것만 고치고 지움, 전체 지우기 불가
      for (const [k, oid] of clean) {
        if (k === "clear") return { ok: false, error: "not_yours" };
        if ((k === "update" || k === "remove") && ps.objs.has(oid!) &&
            (ps.authors.get(oid!) ?? this.lastAuthor(ps.id, oid!)) !== a.sub) return { ok: false, error: "not_yours" };
      }
    }

    // 상태를 실제로 바꾸는 동작만 순번을 받습니다(재전송된 중복 add 등은 무시).
    const preview = new Map(ps.objs);
    const accepted: typeof clean = [];
    for (const [k, oid, data] of clean) {
      if (k === "add" && preview.has(oid!)) continue;
      if ((k === "update" || k === "remove") && !preview.has(oid!)) continue;
      if (k === "clear" && !preview.size) continue;
      if (k === "add" || k === "update") preview.set(oid!, data!);
      else if (k === "remove") preview.delete(oid!);
      else preview.clear();
      accepted.push([k, oid, data]);
    }
    if (!accepted.length) return { ok: true, from: null, to: null, seq: ps.seq, bid };

    const first = ps.seq + 1;
    const now = Date.now();
    const rows = accepted.map(([k, oid, data], i) => ({ s: first + i, k, id: oid, d: data }));
    this.ctx.storage.transactionSync(() => {
      for (const r of rows) {
        this.sql.exec("INSERT INTO ops (page_id, seq, kind, obj_id, data, ts, author) VALUES (?, ?, ?, ?, ?, ?, ?)",
          ps.id, r.s, r.k, r.id, r.d ? JSON.stringify(r.d) : null, now, a.sub);
      }
      this.sql.exec("UPDATE pages SET last_seq = ?, updated_at = ? WHERE id = ?", rows[rows.length - 1].s, now, ps.id);
    });
    for (const r of rows) {
      ps.apply(r.k, r.id, r.d);
      if (r.k === "add" || r.k === "update") ps.authors.set(r.id!, a.sub);
      else if (r.k === "remove") ps.authors.delete(r.id!);
    }
    ps.seq = rows[rows.length - 1].s;
    ps.last_change = now;
    if (ps.seq - ps.saved_seq >= SNAP_EVERY_OPS) this.savePage(ps);
    await this.scheduleAlarm();

    this.emit("op:batch", { page_id: ps.id, cid, bid, from: first, to: ps.seq, author: a.sub, ops: rows });
    return { ok: true, from: first, to: ps.seq, seq: ps.seq, bid };
  }
}
