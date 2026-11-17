/**
 * classboard — Worker 진입점
 *
 *   /ws               → 학급 DO (칠판 WebSocket, ?token=&device=)
 *   /eboard-api/*     → 학급 DO (REST. 경로는 jmschool판과 같게 둡니다)
 *   /probe-ws, /api/stats, /api/where → 검증용 DO (probe.html)
 *   /eboard-api/uninstall/wipe-files → 설치 도우미 [지우기]: 확장판 R2 비우기(설치 키 필요)
 *   /api/health       → 버전·이 요청을 받은 데이터센터
 *   그 밖             → web/ 정적 파일 (assets 가 먼저 처리하고, 없는 경로만 여기로 옴)
 */
import { helperZip } from "./helper";
import { SERVER_VERSION } from "./room";
export { ClassRoom } from "./room";
export { ProbeRoom } from "./probe";

export interface Env {
  ROOM: DurableObjectNamespace;
  PROBE: DurableObjectNamespace;
  ASSETS: Fetcher;
  SETUP_KEY?: string;
  FILES?: R2Bucket;          // 확장판(wrangler.storage.jsonc)에서만 연결
  EDITION?: string;          // "local": 로컬판(교사 PC 에서 wrangler dev 로 실행, wrangler.local.jsonc)
}

const editionOf = (env: Env) => (env.EDITION === "local" ? "local" : env.FILES ? "storage" : "basic");

/** 로컬판: 이 PC 주소(localhost·127.0.0.1)로 온 요청만 받음 — 다른 사이트가 DNS 로 이 PC 를 가리키는 공격(rebinding) 막기 */
function localHostOk(req: Request, url: URL): boolean {
  if (!["localhost", "127.0.0.1"].includes(url.hostname)) return false;
  const origin = req.headers.get("Origin");
  if (origin && origin !== "null") {
    try { if (!["localhost", "127.0.0.1"].includes(new URL(origin).hostname)) return false; } catch { return false; }
  }
  return true;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

// 설치 하나 = 학급 하나이므로 DO 이름은 고정. 배치 힌트 없이 처음 접속한 곳 가까이에 만들어집니다.
const classRoom = (env: Env) => env.ROOM.get(env.ROOM.idFromName("class"));

function probeRoom(env: Env, url: URL) {
  if (url.searchParams.get("room") === "apac") return env.PROBE.get(env.PROBE.idFromName("class-apac"), { locationHint: "apac" });
  return env.PROBE.get(env.PROBE.idFromName("class"));
}

/** 브라우저가 보낸 내부용 머리글은 지우고 DO 로 넘깁니다. */
function forward(req: Request, extra: Record<string, string> = {}): Request {
  const headers = new Headers(req.headers);
  for (const k of [...headers.keys()]) if (k.startsWith("x-cb-")) headers.delete(k);
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return new Request(req, { headers });
}

function sameKey(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname;
    const local = env.EDITION === "local";
    if (local && !localHostOk(req, url)) return json({ error: "local_only", message: "로컬판은 이 PC 에서만 열 수 있습니다" }, 421);

    if (p === "/helper.zip" && req.method === "GET") return helperZip(req, env.ASSETS);

    if (p === "/ws") {
      if (req.headers.get("Upgrade") !== "websocket") return json({ error: "websocket_only" }, 426);
      return classRoom(env).fetch(forward(req));
    }

    // 확장판: R2 에 있는 자료는 DO 를 거치지 않고 바로 내려줌(주소의 키가 곧 R2 이름이라 키가 틀리면 없음).
    // 없으면(기본판 때 올린 자료 등) 아래 DO 로 넘어감.
    const file = env.FILES && req.method === "GET" ? /^\/eboard-api\/files\/(\d+)$/.exec(p) : null;
    if (file) {
      const k = url.searchParams.get("k") ?? "";
      if (/^[A-Za-z0-9_-]{8,40}$/.test(k)) {
        const base = `m/${file[1]}/${k}`;
        const obj = (url.searchParams.get("t") === "1" ? await env.FILES!.get(base + ".t") : null) ?? await env.FILES!.get(base);
        if (obj) {
          const h = new Headers({ "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff" });
          if (obj.httpMetadata?.contentType) h.set("content-type", obj.httpMetadata.contentType);
          h.set("etag", obj.httpEtag);
          return new Response(obj.body, { headers: h });
        }
      }
    }

    if (p.startsWith("/eboard-api/")) {
      if (local && p === "/eboard-api/auth/local" && req.method === "POST") return classRoom(env).fetch(forward(req, { "x-cb-local": "ok" }));
      if (local && p === "/eboard-api/setup" && req.method === "POST") {
        // 로컬판 처음 설정: 설치 키·교사 아이디 없이(이 PC 에서만 열리고 로그인도 하지 않음). 이미 설정했으면 막음
        const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        const st = await classRoom(env).fetch(new Request(new URL("/eboard-api/setup/status", url)));
        if (((await st.json().catch(() => ({}))) as { configured?: boolean }).configured) {
          return json({ detail: { error: "configured", message: "이미 처음 설정을 했습니다" } }, 409);
        }
        const rnd = crypto.getRandomValues(new Uint8Array(18));
        const body = JSON.stringify({ ...b, login_id: "local", password: btoa(String.fromCharCode(...rnd)) });
        const headers = new Headers({ "content-type": "application/json", "x-cb-setup": "ok" });
        return classRoom(env).fetch(new Request(url.toString(), { method: "POST", headers, body }));
      }
      if (p === "/eboard-api/setup" && req.method === "POST") {
        // 설치 키(Cloudflare 비밀값 SETUP_KEY)는 여기서만 확인합니다.
        if (!env.SETUP_KEY) {
          return json({ detail: { error: "no_setup_key", message: "Cloudflare 설정에 SETUP_KEY 비밀값이 없습니다. 설치 안내를 보고 먼저 넣어 주세요." } }, 503);
        }
        const body = (await req.clone().json().catch(() => ({}))) as { setup_key?: string };
        if (!sameKey(String(body.setup_key ?? ""), env.SETUP_KEY)) {
          return json({ detail: { error: "bad_setup_key", message: "설치 키가 맞지 않습니다" } }, 403);
        }
        return classRoom(env).fetch(forward(req, { "x-cb-setup": "ok" }));
      }
      if (p === "/eboard-api/uninstall/wipe-files" && req.method === "POST") {
        // 설치 도우미의 [지우기] 전용: 확장판 R2 버킷을 비웁니다(비어 있어야 버킷을 지울 수 있음).
        // 설치 키는 Cloudflare 에 로그인한 사람만 바꿀 수 있고, 설치 키로는 원래 교사 계정도 다시 정할 수 있으므로 같은 권한입니다.
        if (!env.SETUP_KEY) return json({ detail: { error: "no_setup_key", message: "SETUP_KEY 비밀값이 없습니다" } }, 503);
        const body = (await req.json().catch(() => ({}))) as { setup_key?: string };
        if (!sameKey(String(body.setup_key ?? ""), env.SETUP_KEY)) {
          return json({ detail: { error: "bad_setup_key", message: "설치 키가 맞지 않습니다" } }, 403);
        }
        if (!env.FILES) return json({ ok: true, deleted: 0, done: true });
        let deleted = 0;
        let done = false;
        for (let i = 0; i < 20; i++) {          // 한 번에 최대 2만 개. 남으면 도우미가 다시 부름
          const l = await env.FILES.list({ limit: 1000 });
          if (l.objects.length === 0) { done = true; break; }
          await env.FILES.delete(l.objects.map((o) => o.key));
          deleted += l.objects.length;
        }
        return json({ ok: true, deleted, done });
      }
      return classRoom(env).fetch(forward(req));
    }

    if (p === "/api/health") {
      const cf = (req as Request & { cf?: { colo?: string; country?: string } }).cf;
      return json({ ok: true, version: SERVER_VERSION, edition: editionOf(env),
        colo: cf?.colo ?? null, country: cf?.country ?? null, setup_key: local || !!env.SETUP_KEY });
    }

    if (p === "/probe-ws") {
      if (req.headers.get("Upgrade") !== "websocket") return json({ error: "websocket_only" }, 426);
      return probeRoom(env, url).fetch(req);
    }
    if (p === "/api/stats" || p === "/api/where") {
      try {
        return await probeRoom(env, url).fetch(new Request(new URL(p === "/api/stats" ? "/stats" : "/where", url), { method: "GET" }));
      } catch (e) {
        return json({ error: "do_unavailable", message: String(e) }, 503);
      }
    }

    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;
