/**
 * 판서 객체 검증 (jmschool판 board.py 이식)
 * 클라이언트가 보낸 획(stroke)·도형(shape)을 검사하고, 저장할 모양으로 정리합니다.
 */

export class OpError extends Error {}

export const ID_RE = /^[A-Za-z0-9_-]{6,24}$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const TOOLS = new Set(["pen", "hl"]);
export const KINDS = new Set(["add", "update", "remove", "clear"]);
const SHAPE_KINDS = new Set(["segment", "ray", "line", "arrow", "rect", "polygon", "circle", "ellipse", "arc", "sector", "angle"]);
export const BG_TYPES = new Set(["none", "grid", "dots", "coord"]);
const MAX_POINTS = 5000;
export const MAX_LIVE_POINTS = 600;
export const MAX_OPS_PER_BATCH = 200;
const URL_RE = /^https?:\/\/[^\s<>"'\\]{3,1000}$/;

export type Obj = Record<string, unknown> & { id: string };

export function num(v: unknown, lo: number, hi: number): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < lo || v > hi) throw new OpError("bad_number");
  return v;
}

const round1 = (v: number) => Math.round(v * 10) / 10;

function validateShape(d: Record<string, unknown>, pw: number, ph: number): Obj {
  const kind = d.kind as string;
  if (!SHAPE_KINDS.has(kind)) throw new OpError("bad_kind");
  if (typeof d.c !== "string" || !COLOR_RE.test(d.c)) throw new OpError("bad_color");
  const fill = d.fill ?? null;
  if (fill !== null && (typeof fill !== "string" || !COLOR_RE.test(fill))) throw new OpError("bad_fill");
  const pts = d.pts;
  if (!Array.isArray(pts) || pts.length < 2 || pts.length % 2 || pts.length > 400) throw new OpError("bad_points");
  const m = 4000;
  for (let i = 0; i < pts.length; i += 2) {
    num(pts[i], -m, pw + m);
    num(pts[i + 1], -m, ph + m);
  }
  const out: Obj = {
    id: d.id as string, t: "shape", kind, c: d.c, w: num(d.w, 1, 60),
    fill, labels: !!d.labels, pts: (pts as number[]).map(round1),
  };
  for (const [k, lo, hi] of [["r", 0, 20000], ["rx", 0, 20000], ["ry", 0, 20000], ["a0", -50, 50], ["a1", -50, 50]] as const) {
    if (d[k] !== undefined && d[k] !== null) out[k] = num(d[k], lo, hi);
  }
  return out;
}

export function validateObj(d: unknown, pw: number, ph: number): Obj {
  if (!d || typeof d !== "object") throw new OpError("bad_obj");
  const o = d as Record<string, unknown>;
  if (o.t === "shape") return validateShape(o, pw, ph);
  if (o.t !== "stroke") throw new OpError("bad_type");
  if (!TOOLS.has(o.tool as string)) throw new OpError("bad_tool");
  if (typeof o.c !== "string" || !COLOR_RE.test(o.c)) throw new OpError("bad_color");
  const w = num(o.w, 1, 400);
  const pts = o.pts;
  if (!Array.isArray(pts) || pts.length < 3 || pts.length % 3 || pts.length > MAX_POINTS * 3) throw new OpError("bad_points");
  const m = 2000;
  for (let i = 0; i < pts.length; i += 3) {
    num(pts[i], -m, pw + m);
    num(pts[i + 1], -m, ph + m);
    num(pts[i + 2], 0, 255);
  }
  return { id: o.id as string, t: "stroke", tool: o.tool, c: o.c, w, sp: !!o.sp, pts: (pts as number[]).map((p) => Math.round(p)) };
}

export function cleanWebUrl(url: unknown): string {
  if (typeof url !== "string" || !URL_RE.test(url.trim())) throw new OpError("bad_url");
  return url.trim();
}

export function cleanColor(c: unknown): string | null {
  if (c === null || c === undefined) return null;
  const s = String(c).toLowerCase();
  if (!/^#[0-9a-f]{6}$/.test(s)) throw new OpError("bad_color");
  return s === "#ffffff" ? null : s;
}
