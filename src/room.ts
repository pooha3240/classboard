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
import { sign, verify, TokenError, randomKey, hashPassword, checkPassword, type TokenPayload } from "./lib/token";
import { currentPeriod, kstNow, nextBoundary, periodLabel, type Bell } from "./lib/periods";
import {
  OpError, ID_RE, KINDS, BG_TYPES, MAX_LIVE_POINTS, MAX_OPS_PER_BATCH,
  validateObj, cleanWebUrl, cleanColor, num, type Obj,
} from "./lib/validate";

export const SERVER_VERSION = "0.2.0";

const TEACHER_DEVICES = new Set(["display", "teacher-pc", "teacher-tablet"]);
const TOKEN_DAYS = 30;
const SNAP_EVERY_OPS = 50;
const SNAP_IDLE_MS = 15_000;

interface Att {
  id: string;
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
const CODE_CHARS = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

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
      bg_meta: this.bg_meta, bg_url: null, bg_color: this.bg_color, play: null };
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
  private pages = new Map<number, PageState>();
  private loginFails = { n: 0, until: 0 };
  private joinFails = { n: 0, until: 0 };

  constructor(ctx: DurableObjectState, env: Record<string, unknown>) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
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
      CREATE TABLE IF NOT EXISTS grants (
        id INTEGER PRIMARY KEY AUTOINCREMENT, num INTEGER NOT NULL, mode TEXT NOT NULL, status TEXT NOT NULL,
        expires INTEGER NOT NULL, done INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
    `);
  }

  private cfg(k: string): string | null {
    return this.sql.exec<{ v: string }>("SELECT v FROM config WHERE k = ?", k).toArray()[0]?.v ?? null;
  }
  private setCfg(k: string, v: string | number | null): void {
    if (v === null) this.sql.exec("DELETE FROM config WHERE k = ?", k);
    else this.sql.exec("INSERT INTO config (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, String(v));
  }
  private configured(): boolean { return !!this.cfg("secret"); }
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
    if (p.role === "student" && p.cv !== Number(this.cfg("code_ver") || 0)) throw new TokenError("code_changed");
    return p;
  }

  /* ───────────── 학급 코드 ───────────── */

  private newCode(): string {
    const r = crypto.getRandomValues(new Uint8Array(6));
    return [...r].map((b) => CODE_CHARS[b % CODE_CHARS.length]).join("");
  }
  private classCode(): string {
    let c = this.cfg("class_code");
    if (!c) { c = this.newCode(); this.setCfg("class_code", c); this.setCfg("code_ver", 1); }
    return c;
  }
  private codeMatches(input: unknown): boolean {
    const want = this.classCode();
    const got = String(input ?? "").trim().toUpperCase();
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
      if (!reset) {
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

    if (path === "/student/class" && method === "GET") {
      if (!this.configured() || !this.codeMatches(url.searchParams.get("code"))) return fail(404, "bad_code", "학급 코드가 맞지 않습니다");
      const k = this.klass();
      return json({ ok: true, grade: k.grade, class: k.class, size: k.size });
    }
    if (path === "/student/join" && method === "POST") {
      if (!this.configured()) return fail(409, "not_configured", "아직 설치 설정을 하지 않았습니다");
      if (Date.now() < this.joinFails.until) return fail(429, "locked", "잠시 뒤에 다시 시도하세요");
      const b = await body();
      const k = this.klass();
      const n = Number(b.num);
      if (!this.codeMatches(b.code)) {
        if (++this.joinFails.n >= 20) this.joinFails = { n: 0, until: Date.now() + 60_000 };
        return fail(403, "bad_code", "학급 코드가 맞지 않습니다");
      }
      if (!Number.isInteger(n) || n < 1 || n > k.size) return fail(400, "bad_num", "번호를 확인하세요");
      const t = await this.tokenFor({ sub: `s${n}`, name: `${n}번`, role: "student", num: n,
        cv: Number(this.cfg("code_ver") || 1) }, STUDENT_TOKEN_HOURS / 24);
      return json({ ...t, role: "student", num: n, grade: k.grade, class: k.class });
    }

    const u = await this.user(req);
    if (!u) return fail(401, "not_logged_in", "로그인이 필요합니다");
    const teacher = u.role === "teacher";
    if (!teacher) return fail(403, "forbidden", "교사만 사용할 수 있습니다");
    const k = this.klass();

    if (path === "/me" && method === "GET") return json({ me: u, klass: k });
    if (path === "/classes" && method === "GET") return json({ school: 1, classes: [{ grade: k.grade, class: k.class }] });
    if (path === "/auth/pin-status" && method === "GET") return json({ has_pin: false });
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
      this.sql.exec("DELETE FROM arrangements WHERE id = ?", Number(del[1]));
      return json({ ok: true });
    }
    if (/^\/pages\/\d+\/snapshot$/.test(path) && method === "PUT") {
      return json({ ok: true, stored: false });          // 판서 기록(썸네일·PDF)은 다음 단계에서
    }
    return fail(404, "not_available", "이 판에서는 아직 지원하지 않는 기능입니다");
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

    if (error || !user) {
      server.send(JSON.stringify({ e: "auth-error", d: { error } }));
      server.close(4001, error ?? "auth");
      return new Response(null, { status: 101, webSocket: client });
    }
    const att: Att = { id: randomKey(6), sub: user.sub, name: user.name ?? "", role: user.role, device, joined: false,
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

  private createSession(day: string, period: number): Json {
    const id = this.sql.exec<{ id: number }>(
      "INSERT INTO sessions (day, period_from, period_to, created_at) VALUES (?, ?, ?, ?) RETURNING id",
      day, period, period, Date.now()).one().id;
    this.createPage(id);
    return this.getSession(id)!;
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
    if (at === Infinity) return;
    const cur = await this.ctx.storage.getAlarm();
    if (cur === null || cur > at || cur < Date.now()) await this.ctx.storage.setAlarm(at);
  }

  async alarm(): Promise<void> {
    this.flushPages();
    this.expireGrants();
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
        const s = this.getSession(Number(d.session_id));
        if (!s) return { ok: false, error: "bad_session" };
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
        const bg = String(d.bg_type);
        const metaIn = (d.bg_meta ?? {}) as Json;
        let meta: Json;
        if (BG_TYPES.has(bg)) meta = { size: Math.round(num(metaIn.size ?? 80, 20, 400)) };
        else if (bg === "web") meta = { url: cleanWebUrl(metaIn.url) };
        else return { ok: false, error: "not_available" };     // 사진·PDF·동영상 배경은 다음 단계
        ps.bg_type = bg; ps.bg_meta = meta;
        this.sql.exec("UPDATE pages SET bg_type = ?, bg_meta = ?, updated_at = ? WHERE id = ?", bg, JSON.stringify(meta), Date.now(), ps.id);
        this.emit("page:bg", { page_id: ps.id, bg_type: bg, bg_meta: meta, bg_url: null, play: null });
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
