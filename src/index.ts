/**
 * classboard — Worker 진입점
 *
 *   /ws               → 학급 DO (칠판 WebSocket, ?token=&device=)
 *   /eboard-api/*     → 학급 DO (REST. 경로는 jmschool판과 같게 둡니다)
 *   /probe-ws, /api/stats, /api/where → 검증용 DO (probe.html)
 *   /api/health       → 버전·이 요청을 받은 데이터센터
 *   그 밖             → web/ 정적 파일 (assets 가 먼저 처리하고, 없는 경로만 여기로 옴)
 */
import { SERVER_VERSION } from "./room";
export { ClassRoom } from "./room";
export { ProbeRoom } from "./probe";

export interface Env {
  ROOM: DurableObjectNamespace;
  PROBE: DurableObjectNamespace;
  ASSETS: Fetcher;
  SETUP_KEY?: string;
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

    if (p === "/ws") {
      if (req.headers.get("Upgrade") !== "websocket") return json({ error: "websocket_only" }, 426);
      return classRoom(env).fetch(forward(req));
    }

    if (p.startsWith("/eboard-api/")) {
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
      return classRoom(env).fetch(forward(req));
    }

    if (p === "/api/health") {
      const cf = (req as Request & { cf?: { colo?: string; country?: string } }).cf;
      return json({ ok: true, version: SERVER_VERSION, colo: cf?.colo ?? null, country: cf?.country ?? null, setup_key: !!env.SETUP_KEY });
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
