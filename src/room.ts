/**
 * 학급 Durable Object (검증용)
 *
 * - WebSocket Hibernation API 로 연결을 받습니다(연결만 유지할 때는 실행 시간 과금 없음).
 * - "ping" 은 자동 응답으로 처리해 DO를 깨우지 않고 요청 수에도 잡히지 않게 합니다.
 * - 받은 메시지 수를 UTC 날짜별로 셉니다. 무료 한도는 UTC 0시(한국 오전 9시)에 초기화됩니다.
 *   메시지마다 저장하면 SQLite 쓰기 한도(하루 10만 행)를 먼저 써 버리므로,
 *   메모리에서 세고 5,000개마다·연결이 끊길 때 한 번씩만 저장합니다.
 */
import { DurableObject } from "cloudflare:workers";

type Role = "teacher" | "board" | "student" | "probe";
const ROLES: Role[] = ["teacher", "board", "student", "probe"];

interface Attachment {
  id: string;
  role: Role;
}

const PERSIST_EVERY = 5000;
const COUNT_REPORT_EVERY = 1000;

function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

export class ClassRoom extends DurableObject<Record<string, unknown>> {
  private day = utcDay();
  private received = 0;
  private unsaved = 0;

  constructor(ctx: DurableObjectState, env: Record<string, unknown>) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS msg_count (day TEXT PRIMARY KEY, received INTEGER NOT NULL)",
      );
      const row = ctx.storage.sql
        .exec<{ received: number }>("SELECT received FROM msg_count WHERE day = ?", this.day)
        .toArray()[0];
      this.received = row?.received ?? 0;
    });
  }

  private rollDay(): void {
    const today = utcDay();
    if (today !== this.day) {
      this.persist();
      this.day = today;
      this.received = 0;
      this.unsaved = 0;
    }
  }

  private persist(): void {
    if (this.unsaved === 0) return;
    this.ctx.storage.sql.exec(
      "INSERT INTO msg_count (day, received) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET received = excluded.received",
      this.day,
      this.received,
    );
    this.unsaved = 0;
  }

  private bump(): void {
    this.rollDay();
    this.received++;
    this.unsaved++;
    if (this.unsaved >= PERSIST_EVERY) this.persist();
  }

  private peers(): Record<Role, number> {
    const out = { teacher: 0, board: 0, student: 0, probe: 0 } as Record<Role, number>;
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attachment | null;
      if (a) out[a.role]++;
    }
    return out;
  }

  private broadcast(data: string, except?: WebSocket): void {
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      const a = ws.deserializeAttachment() as Attachment | null;
      if (a?.role === "probe") continue; // 한도 시험 연결에는 판서를 보내지 않음
      try {
        ws.send(data);
      } catch {
        /* 끊긴 연결은 webSocketClose 에서 정리 */
      }
    }
  }

  private stats() {
    this.rollDay();
    return { day: this.day, received: this.received, peers: this.peers() };
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/stats") {
      return new Response(JSON.stringify(this.stats()), {
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
      });
    }

    if (url.pathname === "/where") {
      // DO 안에서 바깥으로 요청을 보내면, 그 요청이 나가는 데이터센터가 곧 DO가 도는 곳입니다.
      let colo: string | null = null;
      try {
        const trace = await (await fetch("https://www.cloudflare.com/cdn-cgi/trace")).text();
        colo = /^colo=(\w+)$/m.exec(trace)?.[1] ?? null;
      } catch {
        /* 진단 실패는 null 로 보고 */
      }
      return new Response(JSON.stringify({ colo }), {
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
      });
    }

    if (req.headers.get("Upgrade") !== "websocket") {
      return new Response("websocket only", { status: 426 });
    }

    const roleParam = url.searchParams.get("role") as Role | null;
    const role: Role = roleParam && ROLES.includes(roleParam) ? roleParam : "teacher";
    const id = crypto.randomUUID().slice(0, 8);

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, [role]);
    server.serializeAttachment({ id, role } satisfies Attachment);

    server.send(JSON.stringify({ t: "hello", id, role, ...this.stats() }));
    this.broadcast(JSON.stringify({ t: "peers", peers: this.peers() }), server);

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    this.bump();
    if (typeof message !== "string") return;

    let msg: { t?: string; [k: string]: unknown };
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }
    const me = ws.deserializeAttachment() as Attachment | null;

    switch (msg.t) {
      case "echo": // 지연 측정: 보낸 쪽에만 그대로 돌려줌
        ws.send(JSON.stringify({ t: "echo", ts: msg.ts }));
        break;

      case "stroke:live": // 그리는 중인 획: 다른 기기에 전달만
      case "stroke:end":
      case "clear":
        this.broadcast(JSON.stringify({ ...msg, from: me?.id }), ws);
        break;

      case "probe": // 한도 시험용: 세기만 하고, 1,000개마다 받은 수를 알려줌
        if (this.received % COUNT_REPORT_EVERY === 0) {
          ws.send(JSON.stringify({ t: "count", received: this.received, day: this.day }));
        }
        break;

      case "stats":
        ws.send(JSON.stringify({ t: "stats", ...this.stats() }));
        break;
    }
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    this.persist();
    try {
      ws.close(code === 1005 ? 1000 : code, "bye");
    } catch {
      /* 이미 닫힘 */
    }
    this.broadcast(JSON.stringify({ t: "peers", peers: this.peers() }), ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.persist();
    this.broadcast(JSON.stringify({ t: "peers", peers: this.peers() }), ws);
  }
}
