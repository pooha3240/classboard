// 나이스 파일 읽기(브라우저에서): 교육과정 연간지도계획 엑셀 → 진도 줄, 학기별 시간표 조회 PDF → 교시별 과목
// jmschool판 서버(plan.py)의 parse_xlsx·parse_tt_pdf 를 옮긴 것입니다. 서버에는 읽은 결과(JSON)만 보냅니다.

export class NeisError extends Error {}

// ── xlsx(zip + XML) 직접 읽기: 외부 라이브러리 없이 ──
async function unzip(buf) {
  const u8 = new Uint8Array(buf), dv = new DataView(buf);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 66000); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new NeisError('엑셀 파일이 아닙니다(.xlsx 로 내려받은 파일인지 확인하세요)');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const files = new Map();
  const dec = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true), elen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + elen + clen;
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    files.set(name, { method, data: u8.subarray(start, start + csize) });
  }
  return {
    has: (name) => files.has(name),
    names: () => [...files.keys()],
    async text(name) {
      const f = files.get(name);
      if (!f) return null;
      if (f.method === 0) return dec.decode(f.data);
      if (f.method !== 8) throw new NeisError('지원하지 않는 압축 형식입니다');
      if (typeof DecompressionStream === 'undefined') throw new NeisError('이 브라우저에서는 엑셀을 읽을 수 없습니다. 최신 크롬·엣지에서 올려 주세요');
      const s = new Blob([f.data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return new Response(s).text();
    },
  };
}

const xml = (s) => new DOMParser().parseFromString(s, 'application/xml');
const kids = (el, tag) => [...el.getElementsByTagName(tag)];
const colIndex = (ref) => { let n = 0; for (const ch of ref.replace(/\d+$/, '')) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };

/** 통합 문서의 모든 시트를 [시트][줄][칸] 문자열 표로 */
async function readWorkbook(buf) {
  const z = await unzip(buf);
  const shared = [];
  const ss = await z.text('xl/sharedStrings.xml');
  if (ss) {
    for (const si of kids(xml(ss).documentElement, 'si')) {
      // 글자 조각(<r><t>) 을 이어 붙이되, 읽는 법(<rPh>) 은 뺌
      shared.push(kids(si, 't').filter((t) => !(t.parentNode && t.parentNode.nodeName === 'rPh')).map((t) => t.textContent).join(''));
    }
  }
  // 시트 순서: workbook.xml 의 sheet 순서 → rels 의 파일
  let sheetFiles = [];
  const wb = await z.text('xl/workbook.xml'), rels = await z.text('xl/_rels/workbook.xml.rels');
  if (wb && rels) {
    const target = new Map(kids(xml(rels).documentElement, 'Relationship').map((r) => [r.getAttribute('Id'), r.getAttribute('Target')]));
    sheetFiles = kids(xml(wb).documentElement, 'sheet').map((s) => {
      const t = target.get(s.getAttribute('r:id')) || '';
      return t.startsWith('/') ? t.slice(1) : 'xl/' + t.replace(/^\.\//, '');
    }).filter((f) => z.has(f));
  }
  if (!sheetFiles.length) sheetFiles = z.names().filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]));
  const sheets = [];
  for (const f of sheetFiles) {
    const doc = xml(await z.text(f));
    const rows = [];
    for (const row of kids(doc.documentElement, 'row')) {
      const cells = [];
      for (const c of kids(row, 'c')) {
        const ref = c.getAttribute('r'), t = c.getAttribute('t');
        const v = c.getElementsByTagName('v')[0];
        let val = '';
        if (t === 's') val = shared[+(v ? v.textContent : -1)] ?? '';
        else if (t === 'inlineStr') val = kids(c, 't').map((x) => x.textContent).join('');
        else if (v) val = v.textContent;
        if (/^-?\d+\.0+$/.test(val)) val = val.replace(/\.0+$/, '');
        const i = ref ? colIndex(ref) : cells.length;
        cells[i] = val.replace(/\s+/g, ' ').trim();
      }
      rows.push(Array.from(cells, (x) => x ?? ''));
    }
    sheets.push(rows);
  }
  return sheets;
}

const WEEKDAYS = { 월: 0, 화: 1, 수: 2, 목: 3, 금: 4, 토: 5, 일: 6 };
const iso = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;

/** '08.21 ~ 08.23' 과 요일 → 날짜. 학년도의 1·2월은 다음 해. */
function dateInWeek(year, m1, d1, wd) {
  const y = m1 <= 2 ? year + 1 : year;
  const start = new Date(Date.UTC(y, m1 - 1, d1));
  if (start.getUTCMonth() !== m1 - 1) return null;
  for (let i = 0; i < 7; i++) {
    const x = new Date(start.getTime() + i * 86400e3);
    if ((x.getUTCDay() + 6) % 7 === wd) return iso(x);
  }
  return null;
}

/** 연간지도계획 엑셀 → {year, term, grade, class, rows:[{date, period, subject, unit, topic, no, total, pages, note}]} */
export async function parsePlanXlsx(buf) {
  let sheets;
  try { sheets = await readWorkbook(buf); } catch (e) {
    if (e instanceof NeisError) throw e;
    throw new NeisError('엑셀 파일을 열 수 없습니다(나이스에서 내려받은 .xlsx 인지 확인하세요)');
  }
  let year = null, term = null, grade = null, cls = null, cols = null, period = null, day = null;
  const rows = [], perDay = new Map();
  for (const sheet of sheets) {
    for (const cells of sheet) {
      const line = cells.filter(Boolean).join(' ');
      if (!line) continue;
      let m;
      if (year === null && (m = line.match(/(\d{4})학년도\s*([12])학기/))) { year = +m[1]; term = +m[2]; }
      if (grade === null && (m = line.match(/(\d)\s*학년\s*(\d{1,2})\s*반/))) { grade = +m[1]; cls = +m[2]; }
      if (cells.includes('과목명') && cells.includes('차시')) {              // 쪽마다 반복되는 제목 줄
        cols = {};
        for (const name of ['주', '기간', '요일', '과목명', '단원명', '학습주제', '차시', '쪽수', '비고']) if (cells.includes(name)) cols[name] = cells.indexOf(name);
        continue;
      }
      if (!cols) continue;
      const g = (k) => (k in cols && cols[k] < cells.length ? cells[cols[k]] : '');
      if (g('기간')) period = g('기간');
      if (g('요일')) day = g('요일');
      const subject = g('과목명');
      if (!subject || !period || !(day in WEEKDAYS) || year === null) continue;
      m = period.match(/(\d{1,2})\.(\d{1,2})\s*~\s*(\d{1,2})\.(\d{1,2})/);
      if (!m) continue;
      const d = dateInWeek(year, +m[1], +m[2], WEEKDAYS[day]);
      if (!d) continue;
      perDay.set(d, (perDay.get(d) || 0) + 1);
      let no = null, total = null;
      const mm = g('차시').match(/(\d+)\s*\/\s*(\d+)/);
      if (mm) { no = +mm[1]; total = +mm[2]; }
      rows.push({ date: d, period: perDay.get(d), subject: subject.slice(0, 30), unit: g('단원명').slice(0, 150),
        topic: g('학습주제').slice(0, 250), no, total, pages: g('쪽수').slice(0, 40), note: g('비고').slice(0, 200) });
    }
  }
  if (!rows.length) throw new NeisError("진도표 내용을 찾지 못했습니다. 나이스 '교육과정 연간지도계획'을 엑셀로 내려받은 파일인지 확인하세요");
  if (year === null || term === null) throw new NeisError('파일에서 학년도·학기를 찾지 못했습니다');
  if (Math.max(...rows.map((r) => r.period)) > 9) throw new NeisError('하루 수업이 9시간을 넘는 날이 있습니다. 파일 형식을 확인하세요');
  return { year, term, grade, class: cls, rows };
}

// ── 학기별 시간표 조회 PDF ──
export const ABBR = { 국: '국어', 사: '사회', 도: '도덕', 수: '수학', 과: '과학', 실: '실과', 체: '체육', 음: '음악',
  미: '미술', 영: '영어', 자: '자율·자치활동', 동: '동아리활동', 진: '진로활동', 봉: '봉사활동' };

/**
 * 시간표 PDF → {grade, class, rows:[[date, period, 한 글자 과목]], holidays:[date]}
 * 표 머리의 교시 번호(요일마다 1~8) 위치로 칸을 정하고, 주마다 '(YYYYMMDD~YYYYMMDD)' 바로 위 줄의 글자를 칸에 넣습니다.
 * 한 날에 과목 글자가 아닌 글자가 있으면(대체공휴일·추석연휴 등) 그날은 수업 없음.
 */
export async function parseTtPdf(buf, pdfjs) {
  const task = pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, cMapUrl: '/vendor/pdfjs/cmaps/', cMapPacked: true,
    standardFontDataUrl: '/vendor/pdfjs/standard_fonts/' });
  let doc;
  try { doc = await task.promise; } catch { task.destroy(); throw new NeisError('PDF 를 열 수 없습니다'); }
  let grade = null, cls = null;
  const out = new Map(), holidays = new Set();
  try {
    for (let pn = 1; pn <= doc.numPages; pn++) {
      const page = await doc.getPage(pn);
      const vp = page.getViewport({ scale: 1 });                 // 쪽 회전까지 반영된 화면 좌표(위가 0)
      const tc = await page.getTextContent();
      const chars = [];
      for (const it of tc.items) {
        const s = it.str || '';
        if (!s.trim()) continue;
        const t = pdfjs.Util.transform(vp.transform, it.transform);
        const fs = Math.hypot(t[0], t[1]) || 1;
        const ux = t[0] / fs, uy = t[1] / fs;                      // 글자가 나아가는 방향
        const w = (it.width || fs * s.length) * vp.scale;
        const n = [...s].length;
        [...s].forEach((ch, i) => {
          if (!ch.trim()) return;
          const k = (w * (i + 0.5)) / n;
          chars.push([t[4] + ux * k, t[5] + uy * k - fs * 0.35, ch]);
        });
      }
      const lines = new Map();
      for (const [x, y, ch] of chars) { const k = Math.round(y / 3); if (!lines.has(k)) lines.set(k, []); lines.get(k).push([x, ch]); }
      const ys = [...lines.keys()].sort((a, b) => a - b);
      const text = new Map(ys.map((k) => [k, lines.get(k).sort((a, b) => a[0] - b[0]).map((c) => c[1]).join('')]));
      if (grade === null) for (const k of ys) { const m = text.get(k).match(/(\d)학년(\d{1,2})반/); if (m) { grade = +m[1]; cls = +m[2]; break; } }
      const head = ys.find((k) => /^(12345678){5,7}$/.test(text.get(k)));
      if (head === undefined) continue;
      const cols = lines.get(head).map((c) => c[0]);
      const step = (cols[cols.length - 1] - cols[0]) / (cols.length - 1);
      for (const k of ys) {
        const m = text.get(k).match(/\((\d{4})\.?(\d{2})\.?(\d{2})\.?~(\d{4})\.?(\d{2})\.?(\d{2})\.?\)/);
        if (!m || k <= head) continue;
        const start = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
        const monday = new Date(start.getTime() - ((start.getUTCDay() + 6) % 7) * 86400e3);
        const above = ys.filter((j) => j > head && j < k && k - j <= 6 && lines.get(j).some(([x]) => x >= cols[0] - step / 2));
        if (!above.length) continue;
        const row = lines.get(Math.max(...above));
        const days = new Map();
        for (const [x, ch] of row) {
          const ci = Math.round((x - cols[0]) / step);
          if (ci >= 0 && ci < cols.length && Math.abs(cols[ci] - x) < step * 0.6) {
            const di = Math.floor(ci / 8);
            if (!days.has(di)) days.set(di, []);
            days.get(di).push([(ci % 8) + 1, ch]);
          }
        }
        for (const [di, items] of days) {
          if (di > 4) continue;
          const d = iso(new Date(monday.getTime() + di * 86400e3));
          if (items.some(([, ch]) => !(ch in ABBR))) { holidays.add(d); continue; }
          for (const [p, ch] of items) out.set(`${d}|${p}`, ch);
        }
      }
      page.cleanup();
    }
  } finally { task.destroy(); }
  const rows = [...out.entries()].map(([k, ch]) => { const [d, p] = k.split('|'); return [d, +p, ch]; })
    .filter(([d]) => !holidays.has(d)).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]));
  if (!rows.length) throw new NeisError("시간표를 찾지 못했습니다. 나이스 '학기별 시간표 조회'를 PDF 로 내려받은 파일인지 확인하세요");
  return { grade, class: cls, rows, holidays: [...holidays].sort() };
}
