/**
 * 교시 판단 (jmschool판 periods.py 이식)
 * 쉬는 시간은 직전 교시, 1교시 전은 0(아침), 마지막 교시 뒤는 99(방과후).
 * 한국 시간 기준. 한국은 서머타임이 없어 UTC+9 고정으로 계산합니다.
 */

export type Bell = [period: number, start: string, end: string];

export const DEFAULT_BELLS: Bell[] = [
  [1, "09:00", "09:40"],
  [2, "09:50", "10:30"],
  [3, "10:40", "11:20"],
  [4, "11:30", "12:10"],
  [5, "13:00", "13:40"],
  [6, "13:50", "14:30"],
];
const AFTER_LAST_MIN = 15;
export const MORNING = 0;
export const AFTER_SCHOOL = 99;
const NAMES: Record<number, string> = { [MORNING]: "아침", [AFTER_SCHOOL]: "방과후" };

const KST_MS = 9 * 3600 * 1000;

/** 한국 날짜 YYYY-MM-DD 와 하루 중 분, 요일(1=월 … 7=일) */
export function kstNow(now = Date.now()): { day: string; minutes: number; weekday: number } {
  const d = new Date(now + KST_MS);
  const wd = d.getUTCDay();
  return { day: d.toISOString().slice(0, 10), minutes: d.getUTCHours() * 60 + d.getUTCMinutes(), weekday: wd === 0 ? 7 : wd };
}

const toMin = (s: string) => {
  const [h, m] = s.split(":").map(Number);
  return h * 60 + m;
};

export function normalize(rows: Bell[] | null | undefined): Bell[] {
  const out = (rows ?? []).filter((r) => r[0] >= 1 && r[0] <= 9).sort((a, b) => toMin(a[1]) - toMin(b[1]));
  return out.length ? out : DEFAULT_BELLS;
}

export function currentPeriod(bells: Bell[] | null | undefined, minutes: number): number {
  const b = normalize(bells);
  if (minutes < toMin(b[0][1])) return MORNING;
  for (let i = 0; i < b.length; i++) {
    const start = toMin(b[i][1]);
    const next = i + 1 < b.length ? toMin(b[i + 1][1]) : toMin(b[i][2]) + AFTER_LAST_MIN;
    if (start <= minutes && minutes < next) return b[i][0];
  }
  return AFTER_SCHOOL;
}

/** 지금 이후 교시가 바뀌는 다음 시각(ms). 바뀔 때가 없으면 다음 날 0시 */
export function nextBoundary(bells: Bell[] | null | undefined, now = Date.now()): number {
  const { minutes } = kstNow(now);
  const b = normalize(bells);
  const marks = new Set<number>();
  for (let i = 0; i < b.length; i++) {
    marks.add(toMin(b[i][1]));
    if (i + 1 === b.length) marks.add(toMin(b[i][2]) + AFTER_LAST_MIN);
  }
  const later = [...marks].filter((m) => m > minutes).sort((x, y) => x - y)[0];
  const base = now - (now % 60000);                        // 이번 분의 시작
  const deltaMin = later !== undefined ? later - minutes : 24 * 60 - minutes;
  return base + deltaMin * 60000 + 2000;                    // 경계 2초 뒤
}

export function periodLabel(from: number | null, to?: number | null): string {
  if (from === null || from === undefined) return "자유";
  const name = (p: number) => NAMES[p] ?? `${p}교시`;
  if (to === null || to === undefined || to === from) return name(from);
  return `${from}~${to}교시`;
}
