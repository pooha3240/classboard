/**
 * 진도표: 나이스 연간지도계획(엑셀) → 시간 칸·차시, 주간 진도 조정, 차시 자료. (jmschool판 plan.py 이식)
 *
 * 파일은 교사 기기의 브라우저가 읽어 JSON 으로 보냅니다(web/js/neis.js). 여기서는 맞추기·저장만 합니다.
 * 저장은 '시간 칸(날짜·교시·과목)'과 '과목별 차시 순서'로 나눠 두고, 과목마다 n번째 칸에 n번째 차시를 붙입니다.
 * 그래서 칸을 빼거나(행사) 과목을 바꾸면(교체) 그 과목의 뒤 차시가 저절로 밀리고 당겨집니다.
 * 손으로 고친 조정은 기록해 두었다가 진도표·시간표를 다시 올릴 때 다시 적용합니다.
 */
import type { MediaStore } from "./media";
import { fileUrl } from "./media";

type Json = Record<string, unknown>;

export const MAX_MEDIA = 12;                 // 한 차시에 붙일 수 있는 자료 수
export const MAX_PAGES = 60;                 // 한 자료(PDF)의 쪽 수
export const PINNED_QUOTA = 300 * 1000 * 1000;   // 차시에 붙인 사진·PDF(자동 정리 안 함)
const SHORT: Record<string, string> = { "자율·자치활동": "자율", "자율활동": "자율", "동아리활동": "동아리", "진로활동": "진로", "봉사활동": "봉사" };
const ABBR: Record<string, string> = { 국: "국어", 사: "사회", 도: "도덕", 수: "수학", 과: "과학", 실: "실과", 체: "체육", 음: "음악",
  미: "미술", 영: "영어", 자: "자율·자치활동", 동: "동아리활동", 진: "진로활동", 봉: "봉사활동" };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class PlanError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

const isCce = (s: string) => s in SHORT || s.endsWith("활동");
/** 맞출 때만 쓰는 이름: 띄어쓰기·가운뎃점·'자치'를 빼서 '자율·자치활동'과 '자율활동'을 같은 과목으로 봄 */
const canon = (s: string) => s.replace(/[\s·ㆍ.]/g, "").replace("자치", "");
const shortSubject = (s: string) => SHORT[s] ?? s;
const str = (v: unknown, n: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);

async function sha1(s: string): Promise<string> {
  const h = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(s));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const lessonKey = (subject: string, unit: string, topic: string, no: number | null, total: number | null) =>
  sha1(`${subject}|${unit}|${topic}|${no ?? "None"}/${total ?? "None"}`);
const placeholderKey = (subject: string, d: string, p: number) => sha1(`ph|${subject}|${d}|${p}`);

function addDays(d: string, n: number): string {
  return new Date(Date.parse(d + "T00:00:00Z") + n * 86400e3).toISOString().slice(0, 10);
}
function mondayOf(d: string): string {
  const wd = (new Date(d + "T00:00:00Z").getUTCDay() + 6) % 7;
  return addDays(d, -wd);
}

type Term = { id: number; term_key: string; first_date: string; last_date: string; file_name: string; uploaded_at: number; src: string; tt_source: string | null; tt_synced_at: number | null };

/* ───────── 나이스 교육정보 개방 포털(선택: 인증키를 넣은 교사만) ───────── */

export type NeisCfg = { key: string; office: string; school: string; kind: string; base: string };
export const NEIS_TT: Record<string, string> = { 초등학교: "elsTimetable", 중학교: "misTimetable", 고등학교: "hisTimetable" };
const ymd = (d: string) => d.replaceAll("-", "");

/** 나이스 API 한 종류를 끝까지(페이지 넘기며) 받기. 데이터 없음은 빈 목록, 오류는 PlanError. */
export async function neisCall(base: string, path: string, params: Record<string, string>, maxRows = 5000): Promise<Json[]> {
  const rows: Json[] = [];
  for (let idx = 1; idx <= 10; idx++) {
    const q = new URLSearchParams({ Type: "json", pIndex: String(idx), pSize: "1000", ...params });
    let j: Json;
    try {
      const r = await fetch(`${base}/${path}?${q}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15000) });
      j = (await r.json()) as Json;
    } catch (e) {
      throw new PlanError(502, "neis_error", `나이스에 연결하지 못했습니다 (${(e as Error).name})`);
    }
    const body = j[path] as Json[] | undefined;
    if (!body) {
      const res = (j.RESULT ?? {}) as Json;
      if (res.CODE === "INFO-200") break;                       // 해당하는 데이터가 없음
      const msg = String(res.MESSAGE ?? res.CODE ?? "알 수 없음");
      const why = res.CODE === "ERROR-290" || res.CODE === "INFO-300" ? " (인증키를 확인하세요)" : res.CODE === "ERROR-337" ? " (하루 사용량 초과, 내일 다시)" : "";
      throw new PlanError(502, "neis_error", `나이스 응답 오류: ${msg}${why}`);
    }
    const head = ((body[0] ?? {}) as Json).head as Json[] | undefined;
    const total = Number(((head?.[0] ?? {}) as Json).list_total_count ?? 0);
    const batch = (((body[1] ?? {}) as Json).row as Json[] | undefined) ?? [];
    rows.push(...batch);
    if (!batch.length || rows.length >= total || rows.length >= maxRows) break;
  }
  return rows;
}

/** 학교 찾기(설정 화면): 이름으로 */
export async function neisSchools(base: string, key: string, name: string) {
  const params: Record<string, string> = { SCHUL_NM: name };
  if (key) params.KEY = key;
  const rows = await neisCall(base, "schoolInfo", params, 30);
  return rows.map((r) => ({ office: String(r.ATPT_OFCDC_SC_CODE ?? ""), office_name: String(r.ATPT_OFCDC_SC_NM ?? ""), school: String(r.SD_SCHUL_CODE ?? ""),
    name: String(r.SCHUL_NM ?? ""), kind: String(r.SCHUL_KND_SC_NM ?? ""), address: String(r.ORG_RDNMA ?? "") }))
    .filter((r) => r.office && r.school);
}

/** 그 기간 학급 시간표 → [날짜, 교시, 과목] */
export async function neisTimetable(cfg: NeisCfg, grade: number, cls: number, d1: string, d2: string): Promise<[string, number, string][]> {
  const path = NEIS_TT[cfg.kind] ?? "elsTimetable";
  const rows = await neisCall(cfg.base, path, { KEY: cfg.key, ATPT_OFCDC_SC_CODE: cfg.office, SD_SCHUL_CODE: cfg.school,
    GRADE: String(grade), CLASS_NM: String(cls), TI_FROM_YMD: ymd(d1), TI_TO_YMD: ymd(d2) });
  const out = new Map<string, string>();
  for (const x of rows) {
    const t = String(x.ALL_TI_YMD ?? ""), p = Number(x.PERIO);
    if (!/^\d{8}$/.test(t) || !Number.isInteger(p) || p < 1 || p > 9) continue;
    const subj = String(x.ITRT_CNTNT ?? "").replace(/^[-\s]+/, "").trim().slice(0, 30);
    const k = `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}|${p}`;
    if (subj && !out.has(k)) out.set(k, subj);
  }
  return [...out.entries()].map(([k, sj]) => { const [d, p] = k.split("|"); return [d, Number(p), sj] as [string, number, string]; })
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]));
}
type Slot = { id: number; term_id: number; slot_date: string; period: number; subject: string; orig_subject: string; cancelled: number; note: string };
type Lesson = { id: number; term_id: number; subject: string; seq: number; unit: string; topic: string; lesson_no: number | null; lesson_total: number | null;
  pages: string; note: string; lkey: string; is_repeat: number; placeholder: number; skipped: number };
type PlanRow = { date: string; period: number; subject: string; unit: string; topic: string; no: number | null; total: number | null; pages: string; note: string; _unplaced?: boolean };
type MediaRow = { id: number; lkey: string; ord: number; kind: string; data: string; title: string };

export function lessonLabel(le: Lesson | null | undefined): string {
  if (!le) return "";
  const no = le.lesson_no ? ` ${le.lesson_no}/${le.lesson_total}차시` : "";
  return `${le.unit}${no} · ${le.topic}`.replace(/^[\s·]+|[\s·]+$/g, "").slice(0, 255);
}

export class PlanStore {
  constructor(private sql: SqlStorage, private media: MediaStore) {}

  migrate(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS plan_term (
        id INTEGER PRIMARY KEY AUTOINCREMENT, term_key TEXT NOT NULL UNIQUE, first_date TEXT NOT NULL, last_date TEXT NOT NULL,
        file_name TEXT NOT NULL DEFAULT '', uploaded_at INTEGER NOT NULL, src TEXT NOT NULL, tt_source TEXT);
      CREATE TABLE IF NOT EXISTS plan_tt (tt_date TEXT NOT NULL, period INTEGER NOT NULL, subject TEXT NOT NULL, PRIMARY KEY (tt_date, period));
      CREATE TABLE IF NOT EXISTS plan_slot (
        id INTEGER PRIMARY KEY AUTOINCREMENT, term_id INTEGER NOT NULL, slot_date TEXT NOT NULL, period INTEGER NOT NULL,
        subject TEXT NOT NULL, orig_subject TEXT NOT NULL, cancelled INTEGER NOT NULL DEFAULT 0, note TEXT NOT NULL DEFAULT '');
      CREATE INDEX IF NOT EXISTS plan_slot_term ON plan_slot(term_id, slot_date, period);
      CREATE TABLE IF NOT EXISTS plan_lesson (
        id INTEGER PRIMARY KEY AUTOINCREMENT, term_id INTEGER NOT NULL, subject TEXT NOT NULL, seq INTEGER NOT NULL,
        unit TEXT NOT NULL DEFAULT '', topic TEXT NOT NULL DEFAULT '', lesson_no INTEGER, lesson_total INTEGER,
        pages TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', lkey TEXT NOT NULL,
        is_repeat INTEGER NOT NULL DEFAULT 0, placeholder INTEGER NOT NULL DEFAULT 0, skipped INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS plan_lesson_term ON plan_lesson(term_id, subject, seq);
      CREATE TABLE IF NOT EXISTS plan_edit (id INTEGER PRIMARY KEY AUTOINCREMENT, term_id INTEGER NOT NULL, op TEXT NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS plan_media (
        id INTEGER PRIMARY KEY AUTOINCREMENT, lkey TEXT NOT NULL, ord INTEGER NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS plan_media_lkey ON plan_media(lkey, ord);
    `);
    try { this.sql.exec("ALTER TABLE plan_term ADD COLUMN tt_synced_at INTEGER"); } catch { /* 이미 있음 */ }
  }

  /* ───────── 차시 잇기 ───────── */

  private termFor(d: string): Term | null {
    return (this.sql.exec<Term>("SELECT * FROM plan_term WHERE first_date <= ? AND last_date >= ? ORDER BY id DESC LIMIT 1", d, d).toArray()[0] as Term | undefined) ?? null;
  }

  /** (칸 목록, 칸 id → 차시, 과목 → 남은 차시). 과목마다 n번째 칸에 n번째 차시. */
  private assignment(termId: number) {
    const slots = this.sql.exec<Slot>("SELECT * FROM plan_slot WHERE term_id = ? ORDER BY slot_date, period", termId).toArray() as Slot[];
    const lessons = this.sql.exec<Lesson>("SELECT * FROM plan_lesson WHERE term_id = ? AND skipped = 0 ORDER BY subject, seq", termId).toArray() as Lesson[];
    const queue = new Map<string, Lesson[]>();
    for (const le of lessons) { if (!queue.has(le.subject)) queue.set(le.subject, []); queue.get(le.subject)!.push(le); }
    const pos = new Map<string, number>();
    const assign = new Map<number, Lesson>();
    for (const s of slots) {
      if (s.cancelled) continue;
      const q = queue.get(s.subject) ?? [];
      const i = pos.get(s.subject) ?? 0;
      if (i < q.length) assign.set(s.id, q[i]);
      pos.set(s.subject, i + 1);
    }
    const left = new Map<string, Lesson[]>();
    for (const [subj, q] of queue) if (q.length > (pos.get(subj) ?? 0)) left.set(subj, q.slice(pos.get(subj) ?? 0));
    return { slots, assign, left };
  }

  /** (칸, 차시): 판서 수업을 만들 때 과목·차시 이름을 붙이는 데 씀 */
  lessonFor(d: string, period: number): { slot: Slot | null; lesson: Lesson | null } {
    if (period < 1 || period > 9) return { slot: null, lesson: null };
    const term = this.termFor(d);
    if (!term) return { slot: null, lesson: null };
    const { slots, assign } = this.assignment(term.id);
    const s = slots.find((x) => x.slot_date === d && x.period === period);
    if (!s) return { slot: null, lesson: null };
    return { slot: s, lesson: s.cancelled ? null : assign.get(s.id) ?? null };
  }

  /** 새 수업에 붙일 과목·차시 이름과 차시 자료 */
  sessionInfo(d: string, period: number): { subject: string; lesson: string; lkey: string | null; items: MediaRow[] } | null {
    const { slot, lesson } = this.lessonFor(d, period);
    if (!slot) return null;
    const subject = (slot.cancelled && slot.note ? slot.note : slot.subject).slice(0, 30);
    return { subject, lesson: lessonLabel(lesson), lkey: lesson?.lkey ?? null, items: lesson ? this.mediaRows(lesson.lkey) : [] };
  }

  private mediaRows(lkey: string): MediaRow[] {
    return this.sql.exec<MediaRow>("SELECT * FROM plan_media WHERE lkey = ? ORDER BY ord, id", lkey).toArray() as MediaRow[];
  }
  private mediaCount(lkeys: string[]): Map<string, number> {
    const out = new Map<string, number>();
    for (const k of new Set(lkeys)) out.set(k, this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM plan_media WHERE lkey = ?", k).one().n);
    return out;
  }

  /** 차시에 붙인 사진·PDF 의 자료 묶음(set) — 자동 정리에서 뺌 */
  pinnedSets(): Set<number> {
    const out = new Set<number>();
    for (const r of this.sql.exec<{ data: string }>("SELECT data FROM plan_media WHERE kind = 'pages'")) {
      const ids = (JSON.parse(r.data).assets ?? []) as number[];
      for (const id of ids.slice(0, 1)) { const a = this.media.get(id); if (a) out.add(a.set_id); }
    }
    return out;
  }
  pinnedBytes(extraSet = 0): number {
    const sets = this.pinnedSets();
    if (extraSet) sets.add(extraSet);
    let n = 0;
    for (const s of sets) n += this.sql.exec<{ n: number }>("SELECT COALESCE(SUM(bytes), 0) AS n FROM assets WHERE set_id = ?", s).one().n;
    return n;
  }

  /* ───────── 올리기 ───────── */

  async uploadPlan(body: Json, k: { grade: number; class: number }, force: boolean, name: string) {
    const year = Number(body.year), term = Number(body.term);
    if (!Number.isInteger(year) || year < 2000 || year > 2100 || (term !== 1 && term !== 2)) throw new PlanError(422, "bad_plan", "파일에서 학년도·학기를 찾지 못했습니다");
    if (body.grade && (Number(body.grade) !== k.grade || Number(body.class) !== k.class) && !force) {
      throw new PlanError(409, "class_mismatch", `이 파일은 ${body.grade}학년 ${body.class}반 진도표입니다`);
    }
    const raw = Array.isArray(body.rows) ? (body.rows as Json[]) : [];
    if (!raw.length || raw.length > 2000) throw new PlanError(422, "bad_plan", "진도표 내용이 없거나 너무 깁니다");
    const rows: PlanRow[] = [];
    for (const r of raw) {
      const d = String(r.date ?? ""), p = Number(r.period);
      if (!DATE_RE.test(d) || !Number.isInteger(p) || p < 1 || p > 9) throw new PlanError(422, "bad_plan", "진도표 줄의 날짜·교시가 맞지 않습니다");
      const subject = str(r.subject, 30);
      if (!subject) continue;
      const no = Number.isInteger(r.no) ? Number(r.no) : null, total = Number.isInteger(r.total) ? Number(r.total) : null;
      rows.push({ date: d, period: p, subject, unit: str(r.unit, 150), topic: str(r.topic, 250), no, total, pages: str(r.pages, 40), note: str(r.note, 200) });
    }
    const termKey = `${year}-${term}`;
    const first = rows.reduce((a, r) => (r.date < a ? r.date : a), rows[0].date);
    const last = rows.reduce((a, r) => (r.date > a ? r.date : a), rows[0].date);
    const src = JSON.stringify(rows);
    const old = this.sql.exec<{ id: number }>("SELECT id FROM plan_term WHERE term_key = ?", termKey).toArray()[0];
    let tid: number;
    if (old) {
      this.sql.exec("UPDATE plan_term SET first_date = ?, last_date = ?, file_name = ?, uploaded_at = ?, src = ? WHERE id = ?",
        first, last, name.slice(0, 200), Date.now(), src, old.id);
      tid = old.id;
    } else {
      tid = this.sql.exec<{ id: number }>("INSERT INTO plan_term (term_key, first_date, last_date, file_name, uploaded_at, src) VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
        termKey, first, last, name.slice(0, 200), Date.now(), src).one().id;
    }
    const stats = await this.rebuild(this.getTerm(tid)!);
    const subjects: Record<string, number> = {};
    for (const r of rows) subjects[r.subject] = (subjects[r.subject] ?? 0) + 1;
    return { ok: true, kind: "plan", term: termKey, term_id: tid, first, last, subjects, replaced: !!old, neis: null as Json | null, ...stats };
  }

  async uploadTt(body: Json, k: { grade: number; class: number }, force: boolean) {
    if (body.grade && (Number(body.grade) !== k.grade || Number(body.class) !== k.class) && !force) {
      throw new PlanError(409, "class_mismatch", `이 파일은 ${body.grade}학년 ${body.class}반 시간표입니다`);
    }
    const raw = Array.isArray(body.rows) ? (body.rows as unknown[][]) : [];
    if (!raw.length || raw.length > 2000) throw new PlanError(422, "bad_tt", "시간표 내용이 없거나 너무 깁니다");
    const names = this.sql.exec<{ subject: string }>("SELECT DISTINCT subject FROM plan_lesson").toArray().map((r) => r.subject);
    const full = (abbr: string) => names.find((n) => n.startsWith(abbr)) ?? ABBR[abbr] ?? abbr;
    const rows: [string, number, string][] = [];
    for (const r of raw) {
      const d = String(r[0] ?? ""), p = Number(r[1]), ch = String(r[2] ?? "").trim().slice(0, 2);
      if (!DATE_RE.test(d) || !Number.isInteger(p) || p < 1 || p > 9 || !ch) continue;
      rows.push([d, p, full(ch)]);
    }
    if (!rows.length) throw new PlanError(422, "bad_tt", "시간표를 찾지 못했습니다");
    rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]));
    const d1 = rows[0][0], d2 = rows[rows.length - 1][0];
    this.sql.exec("DELETE FROM plan_tt WHERE tt_date BETWEEN ? AND ?", d1, d2);
    for (const [d, p, s] of rows) this.sql.exec("INSERT OR REPLACE INTO plan_tt (tt_date, period, subject) VALUES (?, ?, ?)", d, p, s);
    this.sql.exec("UPDATE plan_term SET tt_source = 'pdf' WHERE first_date <= ? AND last_date >= ?", d2, d1);
    const rebuilt = [];
    for (const t of this.sql.exec<Term>("SELECT * FROM plan_term WHERE first_date <= ? AND last_date >= ?", d2, d1).toArray() as Term[]) {
      rebuilt.push({ term: t.term_key, ...(await this.rebuild(t)) });
    }
    const holidays = Array.isArray(body.holidays) ? body.holidays.length : 0;
    return { ok: true, kind: "timetable", first: d1, last: d2, hours: rows.length, days: new Set(rows.map((r) => r[0])).size, holidays, rebuilt };
  }

  private getTerm(id: number): Term | null {
    return (this.sql.exec<Term>("SELECT * FROM plan_term WHERE id = ?", id).toArray()[0] as Term | undefined) ?? null;
  }

  /**
   * 진도표 줄 + 학급 시간표 → 시간 칸과 과목별 차시 순서를 새로 만들고, 손으로 고친 조정을 다시 적용.
   * 날마다 시간표 교시 순서대로 진도표 줄을 같은 과목에 맞춰 붙이고, 진도표에 없는 시간(창체 등)은 과목 이름만 둡니다.
   */
  private async rebuild(term: Term) {
    const src = JSON.parse(term.src) as PlanRow[];
    const ttRows = this.sql.exec<{ tt_date: string; period: number; subject: string }>(
      "SELECT tt_date, period, subject FROM plan_tt WHERE tt_date BETWEEN ? AND ? ORDER BY tt_date, period", term.first_date, term.last_date).toArray();
    const tt = new Map<string, [number, string][]>();
    for (const r of ttRows) { if (!tt.has(r.tt_date)) tt.set(r.tt_date, []); tt.get(r.tt_date)!.push([r.period, r.subject]); }
    const plan = new Map<string, PlanRow[]>();
    for (const r of src) { if (!plan.has(r.date)) plan.set(r.date, []); plan.get(r.date)!.push({ ...r }); }
    const stats = { hours: src.length, matched: 0, unplaced: 0, free: 0, with_tt: tt.size > 0, edits: 0, edits_dropped: 0 };
    const ttDays = [...tt.keys()].sort();
    const queue = new Map<string, (["row", PlanRow] | ["ph", string, string, number])[]>();
    // 차시 순서는 시간표의 과목 이름으로 묶음('자율·자치활동' 진도도 시간표가 '자율활동'이면 그 칸에 들어가게)
    const ttName = new Map<string, string>();
    for (const r of ttRows) if (!ttName.has(canon(r.subject))) ttName.set(canon(r.subject), r.subject);
    const push = (name: string, it: ["row", PlanRow] | ["ph", string, string, number]) => {
      const subj = ttName.get(canon(name)) ?? name;
      if (!queue.has(subj)) queue.set(subj, []); queue.get(subj)!.push(it);
    };
    const slotRows: [string, number, string][] = [];
    for (const d of [...new Set([...plan.keys(), ...tt.keys()])].sort()) {
      const rows = plan.get(d) ?? [];
      const slots = tt.get(d);
      if (slots) {
        const used = new Set<number>();
        const bind = new Map<number, PlanRow>();
        for (const r of rows) {                     // 진도표 순서대로, 그날 아직 안 쓴 같은 과목 칸 중 앞의 것에
          const k = slots.findIndex(([, subj], i) => !used.has(i) && canon(subj) === canon(r.subject));
          if (k >= 0) { bind.set(k, r); used.add(k); } else r._unplaced = true;
        }
        slots.forEach(([p, subj], k) => {
          slotRows.push([d, p, subj]);
          if (bind.has(k)) { push(subj, ["row", bind.get(k)!]); stats.matched++; }
          else if (isCce(subj)) { push(subj, ["ph", subj, d, p]); stats.free++; }    // 진도표에 없는 창체 시간: 과목 이름만
          else stats.free++;                                                          // 교체: 그 과목 다음 차시가 들어감
        });
        for (const r of rows) if (r._unplaced) { push(r.subject, ["row", r]); stats.unplaced++; }
      } else if (ttDays.length && ttDays[0] <= d && d <= ttDays[ttDays.length - 1]) {
        for (const r of rows) { push(r.subject, ["row", r]); stats.unplaced++; }       // 시간표 기간인데 수업 없는 날: 차시는 뒤로 밀림
      } else {
        for (const r of rows) { slotRows.push([d, r.period, r.subject]); push(r.subject, ["row", r]); stats.matched++; }   // 시간표 없는 날: 줄 순서 = 교시
      }
    }
    const tid = term.id;
    this.sql.exec("DELETE FROM plan_slot WHERE term_id = ?", tid);
    this.sql.exec("DELETE FROM plan_lesson WHERE term_id = ?", tid);
    for (const [d, p, s] of slotRows) {
      this.sql.exec("INSERT INTO plan_slot (term_id, slot_date, period, subject, orig_subject) VALUES (?, ?, ?, ?, ?)", tid, d, p, s, s);
    }
    for (const [subj, items] of queue) {
      let i = 0;
      for (const it of items) {
        i++;
        if (it[0] === "row") {
          const r = it[1];
          this.sql.exec(`INSERT INTO plan_lesson (term_id, subject, seq, unit, topic, lesson_no, lesson_total, pages, note, lkey, placeholder)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`, tid, subj, i * 100, r.unit, r.topic, r.no, r.total, r.pages, r.note,
            await lessonKey(subj, r.unit, r.topic, r.no, r.total));
        } else {
          this.sql.exec(`INSERT INTO plan_lesson (term_id, subject, seq, lkey, placeholder) VALUES (?, ?, ?, ?, 1)`,
            tid, subj, i * 100, await placeholderKey(subj, it[2], it[3]));
        }
      }
    }
    const [ok, dropped] = this.replayEdits(tid);
    stats.edits = ok; stats.edits_dropped = dropped;
    return stats;
  }

  /** 나이스 시간표로 plan_tt 를 고침. 받은 마지막 날까지만 바꿈(그 뒤는 아직 안 들어온 것). */
  private replaceTt(rows: [string, number, string][], d1: string): { rows: number; changed: boolean; last?: string } {
    if (!rows.length) return { rows: 0, changed: false };
    const last = rows[rows.length - 1][0];
    const old = this.sql.exec<{ tt_date: string; period: number; subject: string }>(
      "SELECT tt_date, period, subject FROM plan_tt WHERE tt_date BETWEEN ? AND ?", d1, last).toArray();
    const key = (d: string, p: number, sj: string) => `${d}|${p}|${sj}`;
    const a = new Set(old.map((r) => key(r.tt_date, r.period, r.subject))), b = new Set(rows.map(([d, p, sj]) => key(d, p, sj)));
    const changed = a.size !== b.size || [...b].some((x) => !a.has(x));
    if (changed) {
      this.sql.exec("DELETE FROM plan_tt WHERE tt_date BETWEEN ? AND ?", d1, last);
      for (const [d, p, sj] of rows) this.sql.exec("INSERT OR REPLACE INTO plan_tt (tt_date, period, subject) VALUES (?, ?, ?)", d, p, sj);
    }
    return { rows: rows.length, changed, last };
  }

  /**
   * 나이스에서 시간표를 받아 학기 진도에 반영. termId 를 주면 그 학기만, 아니면 오늘 이후로 끝나는 학기 모두.
   * 바뀐 게 있거나 force 면 진도를 다시 맞춤(손으로 고친 조정은 다시 적용).
   */
  async syncNeis(cfg: NeisCfg, k: { grade: number; class: number }, today: string, opts: { termId?: number; force?: boolean } = {}) {
    const terms = opts.termId ? [this.getTerm(opts.termId)].filter((t): t is Term => !!t)
      : this.sql.exec<Term>("SELECT * FROM plan_term WHERE last_date >= ? ORDER BY first_date", today).toArray() as Term[];
    if (!terms.length) throw new PlanError(404, "no_term", "진행 중인 학기 진도표가 없습니다. 연간지도계획(엑셀)을 먼저 올려 주세요");
    const out = [];
    for (const t of terms) {
      const rows = await neisTimetable(cfg, k.grade, k.class, t.first_date, t.last_date);
      const r = this.replaceTt(rows, t.first_date);
      if (r.rows) this.sql.exec("UPDATE plan_term SET tt_synced_at = ?, tt_source = 'api' WHERE id = ?", Date.now(), t.id);
      const stats = r.changed || opts.force ? await this.rebuild(this.getTerm(t.id)!) : null;
      out.push({ term: t.term_key, ...r, ...(stats ?? {}) });
    }
    return out;
  }

  terms() {
    const rows = this.sql.exec<Term & { hours: number }>(
      "SELECT t.*, (SELECT COUNT(*) FROM plan_slot s WHERE s.term_id = t.id) AS hours FROM plan_term t ORDER BY first_date DESC").toArray();
    return { terms: rows.map((r) => ({ id: r.id, term: r.term_key, first: r.first_date, last: r.last_date, hours: r.hours, file: r.file_name,
      uploaded_at: new Date(Number(r.uploaded_at) + 9 * 3600e3).toISOString().slice(0, 16).replace("T", " ") })) };
  }

  /* ───────── 주간 진도 ───────── */

  private lessonOut(le: Lesson | undefined | null, counts: Map<string, number>) {
    if (!le) return null;
    return { id: le.id, unit: le.unit, topic: le.topic, no: le.lesson_no, total: le.lesson_total, pages: le.pages, note: le.note, lkey: le.lkey,
      repeat: !!le.is_repeat, ph: !!le.placeholder, media: counts.get(le.lkey) ?? 0 };
  }

  week(day: string, today: string, neisOn = false) {
    const d = DATE_RE.test(day) ? day : today;
    const mon = mondayOf(d), fri = addDays(mon, 4);
    const term = this.termFor(d) ?? ((this.sql.exec<Term>("SELECT * FROM plan_term WHERE first_date <= ? AND last_date >= ? ORDER BY id DESC LIMIT 1", fri, mon).toArray()[0] as Term | undefined) ?? null);
    const base = { monday: mon, today };
    if (!term) {
      const terms = this.sql.exec<{ first_date: string }>("SELECT first_date FROM plan_term").toArray();
      const dist = (x: string) => Math.abs(Date.parse(x) - Date.parse(d));
      const nearest = terms.sort((a, b) => dist(a.first_date) - dist(b.first_date))[0];
      return { ...base, term: null, nearest: nearest ? nearest.first_date : null, neis: neisOn };
    }
    const { slots, assign, left } = this.assignment(term.id);
    const wk = slots.filter((s) => mon <= s.slot_date && s.slot_date <= fri);
    const counts = this.mediaCount(wk.map((s) => assign.get(s.id)?.lkey).filter((x): x is string => !!x));
    const skipped = this.sql.exec<Lesson>("SELECT * FROM plan_lesson WHERE term_id = ? AND skipped = 1 ORDER BY subject, seq", term.id).toArray() as Lesson[];
    const subjects = [...new Set(slots.flatMap((s) => [s.orig_subject, s.subject]))].sort();
    return {
      ...base, neis: neisOn, subjects,
      term: { id: term.id, key: term.term_key, first: term.first_date, last: term.last_date, tt_source: term.tt_source,
        synced: term.tt_synced_at ? new Date(Number(term.tt_synced_at) + 9 * 3600e3).toISOString().slice(5, 16).replace("-", "/").replace("T", " ") : "" },
      slots: wk.map((s) => ({ id: s.id, date: s.slot_date, period: s.period, subject: s.subject, short: shortSubject(s.subject), orig: s.orig_subject,
        cancelled: !!s.cancelled, note: s.note, lesson: s.cancelled ? null : this.lessonOut(assign.get(s.id), counts) })),
      left: [...left.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([subject, v]) => ({ subject, count: v.length, first: lessonLabel(v[0]) })),
      skipped: skipped.map((le) => ({ id: le.id, subject: le.subject, label: lessonLabel(le) })),
    };
  }

  /* ───────── 진도 조정(바로 적용, 기록해 두었다가 다시 맞출 때 다시 적용) ───────── */

  private slotAt(termId: number, ref: Json): Slot | null {
    const s = this.sql.exec<Slot>("SELECT * FROM plan_slot WHERE term_id = ? AND slot_date = ? AND period = ?", termId, String(ref.date), Number(ref.period)).toArray()[0] as Slot | undefined;
    return s && s.orig_subject === ref.orig ? s : null;
  }
  private ref(s: Slot) { return { date: s.slot_date, period: s.period, orig: s.orig_subject }; }

  private repeat(le: Lesson): void {
    const nxt = this.sql.exec<{ s: number | null }>("SELECT MIN(seq) AS s FROM plan_lesson WHERE term_id = ? AND subject = ? AND seq > ?", le.term_id, le.subject, le.seq).one().s;
    let hi = nxt ?? le.seq + 100;
    if (hi - le.seq < 2) {                         // 사이가 꽉 참: 과목 순서를 다시 100 간격으로
      const ids = this.sql.exec<{ id: number }>("SELECT id FROM plan_lesson WHERE term_id = ? AND subject = ? ORDER BY seq", le.term_id, le.subject).toArray();
      ids.forEach((r, i) => this.sql.exec("UPDATE plan_lesson SET seq = ? WHERE id = ?", (i + 1) * 100, r.id));
      le = this.sql.exec<Lesson>("SELECT * FROM plan_lesson WHERE id = ?", le.id).one() as Lesson;
      hi = le.seq + 100;
    }
    this.sql.exec(`INSERT INTO plan_lesson (term_id, subject, seq, unit, topic, lesson_no, lesson_total, pages, note, lkey, is_repeat, placeholder)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`, le.term_id, le.subject, Math.floor((le.seq + hi) / 2), le.unit, le.topic, le.lesson_no, le.lesson_total,
      le.pages, le.note, le.lkey, le.placeholder);
  }

  private applyEdit(termId: number, op: string, d: Json): boolean {
    if (op === "cancel" || op === "restore" || op === "subject") {
      const s = this.slotAt(termId, d);
      if (!s) return false;
      if (op === "cancel") this.sql.exec("UPDATE plan_slot SET cancelled = 1, note = ? WHERE id = ?", str(d.note, 60), s.id);
      else if (op === "restore") this.sql.exec("UPDATE plan_slot SET cancelled = 0, note = '' WHERE id = ?", s.id);
      else this.sql.exec("UPDATE plan_slot SET subject = ?, cancelled = 0, note = '' WHERE id = ?", str(d.subject, 30), s.id);
      return true;
    }
    if (op === "swap") {
      const a = this.slotAt(termId, d.a as Json), b = this.slotAt(termId, d.b as Json);
      if (!a || !b) return false;
      this.sql.exec("UPDATE plan_slot SET subject = ?, cancelled = ?, note = ? WHERE id = ?", b.subject, b.cancelled, b.note, a.id);
      this.sql.exec("UPDATE plan_slot SET subject = ?, cancelled = ?, note = ? WHERE id = ?", a.subject, a.cancelled, a.note, b.id);
      return true;
    }
    const le = this.sql.exec<Lesson>("SELECT * FROM plan_lesson WHERE term_id = ? AND lkey = ? AND is_repeat = ? ORDER BY seq LIMIT 1",
      termId, String(d.lkey), op === "remove" ? 1 : 0).toArray()[0] as Lesson | undefined;
    if (!le) return false;
    if (op === "repeat") this.repeat(le);
    else if (op === "remove") this.sql.exec("DELETE FROM plan_lesson WHERE id = ?", le.id);
    else this.sql.exec("UPDATE plan_lesson SET skipped = ? WHERE id = ?", op === "skip" ? 1 : 0, le.id);
    return true;
  }

  private replayEdits(termId: number): [number, number] {
    const rows = this.sql.exec<{ op: string; data: string }>("SELECT op, data FROM plan_edit WHERE term_id = ? ORDER BY id", termId).toArray();
    let ok = 0;
    for (const r of rows) { try { if (this.applyEdit(termId, r.op, JSON.parse(r.data))) ok++; } catch { /* 건너뜀 */ } }
    return [ok, rows.length - ok];
  }

  /** 조정 하나 적용하고 기록. 영향받은 날짜(이미 만든 판서 이름을 고치는 데 씀)를 돌려줌 */
  private edit(termId: number, op: string, d: Json): string[] {
    if (!this.applyEdit(termId, op, d)) throw new PlanError(409, "gone", "그 시간(차시)이 바뀌었습니다. 화면을 새로 고치세요");
    this.sql.exec("INSERT INTO plan_edit (term_id, op, data, created_at) VALUES (?, ?, ?, ?)", termId, op, JSON.stringify(d), Date.now());
    return [d, d.a, d.b].filter((x): x is Json => !!x && typeof x === "object" && "date" in (x as Json)).map((x) => String(x.date));
  }

  slotAction(slotId: number, b: Json): string[] {
    const s = this.sql.exec<Slot>("SELECT * FROM plan_slot WHERE id = ?", slotId).toArray()[0] as Slot | undefined;
    if (!s) throw new PlanError(404, "not_found", "시간이 없습니다");
    const action = String(b.action);
    if (!["cancel", "restore", "subject"].includes(action)) throw new PlanError(400, "bad_request", "요청이 맞지 않습니다");
    const d: Json = this.ref(s);
    if (action === "cancel") d.note = str(b.note, 60);
    if (action === "subject") { d.subject = str(b.subject, 30); if (!d.subject) throw new PlanError(400, "bad_subject", "과목을 고르세요"); }
    return this.edit(s.term_id, action, d);
  }

  swap(aId: number, bId: number): string[] {
    const a = this.sql.exec<Slot>("SELECT * FROM plan_slot WHERE id = ?", aId).toArray()[0] as Slot | undefined;
    const b = this.sql.exec<Slot>("SELECT * FROM plan_slot WHERE id = ?", bId).toArray()[0] as Slot | undefined;
    if (!a || !b || a.term_id !== b.term_id || a.id === b.id) throw new PlanError(400, "bad_request", "바꿀 두 시간을 확인하세요");
    return this.edit(a.term_id, "swap", { a: this.ref(a), b: this.ref(b) });
  }

  lessonAction(lessonId: number, b: Json): string[] {
    const le = this.sql.exec<Lesson>("SELECT * FROM plan_lesson WHERE id = ?", lessonId).toArray()[0] as Lesson | undefined;
    if (!le) throw new PlanError(404, "not_found", "차시가 없습니다");
    const action = String(b.action);
    if (!["repeat", "skip", "unskip", "remove"].includes(action)) throw new PlanError(400, "bad_request", "요청이 맞지 않습니다");
    if (action === "remove" && !le.is_repeat) throw new PlanError(400, "bad_request", "'한 번 더'로 넣은 차시만 지울 수 있습니다");
    return this.edit(le.term_id, action, { lkey: le.lkey });
  }

  /* ───────── 차시 자료 ───────── */

  private mediaOut(r: MediaRow) {
    const d = JSON.parse(r.data) as Json;
    const out: Json = { id: r.id, kind: r.kind, title: r.title };
    if (r.kind === "pages") {
      const ids = (d.assets as number[]) ?? [];
      out.count = ids.length; out.assets = ids;
      const a = ids.length ? this.media.get(ids[0]) : null;
      out.thumb = a ? fileUrl(a, a.thumb_mime !== null) : null;
    } else if (r.kind === "yt") { out.yt = d.yt; out.start = d.start ?? 0; }
    else out.url = d.url;
    return out;
  }

  mediaList(lkey: string) {
    if (!/^[0-9a-f]{40}$/.test(lkey)) throw new PlanError(400, "bad_key", "차시를 확인하세요");
    return { items: this.mediaRows(lkey).map((r) => this.mediaOut(r)) };
  }

  mediaAdd(b: Json, cleanUrl: (u: unknown) => string) {
    const lkey = String(b.lkey ?? "");
    if (!/^[0-9a-f]{40}$/.test(lkey)) throw new PlanError(400, "bad_key", "차시를 확인하세요");
    const n = this.sql.exec<{ n: number; o: number }>("SELECT COUNT(*) AS n, COALESCE(MAX(ord), 0) AS o FROM plan_media WHERE lkey = ?", lkey).one();
    if (n.n >= MAX_MEDIA) throw new PlanError(400, "too_many", `한 차시에 자료는 ${MAX_MEDIA}개까지입니다`);
    let data: Json;
    const kind = String(b.kind);
    if (kind === "pages") {
      const ids = (Array.isArray(b.assets) ? b.assets : []).map(Number).slice(0, MAX_PAGES);
      const assets = ids.map((id) => this.media.get(id));
      if (!ids.length || assets.some((a) => !a || !a.done)) throw new PlanError(400, "bad_asset", "자료를 확인하세요");
      const set = assets[0]!.set_id;
      if (!this.pinnedSets().has(set) && this.pinnedBytes(set) > PINNED_QUOTA) {
        throw new PlanError(507, "pinned_full", `차시 자료 공간(${Math.round(PINNED_QUOTA / 1e6)}MB)이 찼습니다. 지난 차시의 자료를 빼거나 유튜브·웹 주소로 붙이세요`);
      }
      data = { assets: ids };
    } else if (kind === "yt") {
      const yt = String(b.yt ?? "");
      if (!/^[\w-]{11}$/.test(yt)) throw new PlanError(400, "bad_yt", "유튜브 주소를 확인하세요");
      data = { yt, start: Math.max(0, Math.min(86400, Math.round(Number(b.start) || 0))) };
    } else if (kind === "web") {
      try { data = { url: cleanUrl(b.url) }; } catch { throw new PlanError(400, "bad_url", "주소를 확인하세요"); }
    } else throw new PlanError(400, "bad_kind", "기본판에서는 사진·PDF·유튜브·웹 주소만 붙일 수 있습니다");
    const id = this.sql.exec<{ id: number }>("INSERT INTO plan_media (lkey, ord, kind, data, title, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
      lkey, n.o + 1, kind, JSON.stringify(data), str(b.title, 200), Date.now()).one().id;
    return { ok: true, id };
  }

  mediaDel(id: number) {
    this.sql.exec("DELETE FROM plan_media WHERE id = ?", id);
    return { ok: true };
  }

  mediaMove(id: number, dir: number) {
    const r = this.sql.exec<MediaRow>("SELECT * FROM plan_media WHERE id = ?", id).toArray()[0] as MediaRow | undefined;
    if (!r) throw new PlanError(404, "not_found", "자료가 없습니다");
    const ids = this.sql.exec<{ id: number }>("SELECT id FROM plan_media WHERE lkey = ? ORDER BY ord, id", r.lkey).toArray().map((x) => x.id);
    const i = ids.indexOf(id), j = i + (dir < 0 ? -1 : 1);
    if (j >= 0 && j < ids.length) {
      [ids[i], ids[j]] = [ids[j], ids[i]];
      ids.forEach((x, k) => this.sql.exec("UPDATE plan_media SET ord = ? WHERE id = ?", k + 1, x));
    }
    return { ok: true };
  }

  /** 지금 교시의 차시와 자료(칠판 '자료' 창에서 바로 넣기) */
  now(day: string, period: number) {
    const { slot, lesson } = this.lessonFor(day, period);
    const items = lesson ? this.mediaRows(lesson.lkey).map((r) => this.mediaOut(r)) : [];
    return { period, subject: slot ? slot.subject : null, cancelled: !!slot?.cancelled, lesson: lessonLabel(lesson) || null, lkey: lesson?.lkey ?? null, items };
  }

  /** 차시 자료를 페이지로 깔 내용: [{bg_type, bg_meta, w, h}] */
  pagesFor(items: MediaRow[], imageMeta: (a: NonNullable<ReturnType<MediaStore["get"]>>) => Json,
    pageSize: (w: number, h: number) => [number, number], cleanUrl: (u: unknown) => string) {
    const out: { bg_type: string; bg_meta: Json; w: number; h: number }[] = [];
    for (const it of items) {
      const d = JSON.parse(it.data) as Json;
      try {
        if (it.kind === "pages") {
          for (const id of ((d.assets as number[]) ?? []).slice(0, MAX_PAGES)) {
            const a = this.media.get(Number(id));
            if (!a || !a.done) continue;
            const [w, h] = pageSize(a.w, a.h);
            out.push({ bg_type: a.kind === "pdf" ? "pdf" : "image", bg_meta: imageMeta(a), w, h });
          }
        } else if (it.kind === "web") {
          out.push({ bg_type: "web", bg_meta: { url: cleanUrl(d.url) }, w: 3200, h: 1800 });
        } else if (it.kind === "yt") {
          out.push({ bg_type: "video", bg_meta: { src: "yt", yt: d.yt, start: d.start ?? 0 }, w: 3200, h: 1800 });
        }
      } catch { /* 깔 수 없는 자료는 건너뜀 */ }
    }
    return out;
  }
}
