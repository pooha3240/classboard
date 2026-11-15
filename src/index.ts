/**
 * classboard 검증용 시험판 — Worker 진입점
 *
 *   /ws          → 학급 Durable Object(학급 1개)로 WebSocket 연결
 *   /api/health  → 버전·응답한 Cloudflare 데이터센터
 *   /api/stats   → 학급 DO가 오늘(UTC) 받은 메시지 수
 *   그 밖        → web/ 정적 파일 (assets 가 먼저 처리하고, 없는 경로만 여기로 옴)
 */
export { ClassRoom } from "./room";

// Worker 진입 파일에서는 핸들러·DO 클래스 외의 값을 export하면 안 됩니다.
const VERSION = "0.0.1-probe";

export interface Env {
  ROOM: DurableObjectNamespace;
  ASSETS: Fetcher;
}

// 설치 하나 = 학급 하나이므로 DO 이름은 고정
const ROOM_NAME = "class";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const room = () => env.ROOM.get(env.ROOM.idFromName(ROOM_NAME));

    if (url.pathname === "/ws") {
      if (req.headers.get("Upgrade") !== "websocket") return json({ error: "websocket_only" }, 426);
      return room().fetch(req);
    }

    if (url.pathname === "/api/health") {
      const cf = (req as Request & { cf?: { colo?: string; country?: string } }).cf;
      return json({ ok: true, version: VERSION, colo: cf?.colo ?? null, country: cf?.country ?? null });
    }

    if (url.pathname === "/api/stats") {
      try {
        return await room().fetch(new Request(new URL("/stats", url), { method: "GET" }));
      } catch (e) {
        // 무료 한도를 넘으면 DO 호출 자체가 실패합니다. 그 사실을 화면에 그대로 보여줍니다.
        return json({ error: "do_unavailable", message: String(e) }, 503);
      }
    }

    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;
