/**
 * classboard 검증용 시험판 — Worker 진입점
 *
 *   /ws?room=…        → 학급 Durable Object로 WebSocket 연결
 *   /api/health       → 버전·이 요청을 받은 Cloudflare 데이터센터
 *   /api/stats?room=… → 학급 DO가 오늘(UTC) 받은 메시지 수
 *   /api/where?room=… → 학급 DO가 실제로 돌고 있는 데이터센터(위치 진단)
 *   그 밖             → web/ 정적 파일 (assets 가 먼저 처리하고, 없는 경로만 여기로 옴)
 *
 * room: 기본(us 등 자동 배치) / apac(아시아·태평양 배치 힌트). 위치 진단용으로 둘을 비교합니다.
 */
export { ClassRoom } from "./room";

// Worker 진입 파일에서는 핸들러·DO 클래스 외의 값을 export하면 안 됩니다.
const VERSION = "0.0.2-probe";

export interface Env {
  ROOM: DurableObjectNamespace;
  ASSETS: Fetcher;
}

type RoomKey = "default" | "apac";

// 설치 하나 = 학급 하나. 위치 비교를 위해 배치 힌트가 다른 DO를 하나 더 둡니다.
// locationHint 는 DO가 처음 만들어질 때만 적용되므로 이름을 따로 씁니다.
function roomStub(env: Env, key: RoomKey): DurableObjectStub {
  if (key === "apac") {
    return env.ROOM.get(env.ROOM.idFromName("class-apac"), { locationHint: "apac" });
  }
  return env.ROOM.get(env.ROOM.idFromName("class"));
}

function roomKey(url: URL): RoomKey {
  return url.searchParams.get("room") === "apac" ? "apac" : "default";
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const key = roomKey(url);

    if (url.pathname === "/ws") {
      if (req.headers.get("Upgrade") !== "websocket") return json({ error: "websocket_only" }, 426);
      return roomStub(env, key).fetch(req);
    }

    if (url.pathname === "/api/health") {
      const cf = (req as Request & { cf?: { colo?: string; country?: string } }).cf;
      return json({ ok: true, version: VERSION, colo: cf?.colo ?? null, country: cf?.country ?? null });
    }

    if (url.pathname === "/api/stats" || url.pathname === "/api/where") {
      const inner = url.pathname === "/api/stats" ? "/stats" : "/where";
      try {
        return await roomStub(env, key).fetch(new Request(new URL(inner, url), { method: "GET" }));
      } catch (e) {
        // 무료 한도를 넘으면 DO 호출 자체가 실패합니다. 그 사실을 화면에 그대로 보여줍니다.
        return json({ error: "do_unavailable", message: String(e) }, 503);
      }
    }

    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;
