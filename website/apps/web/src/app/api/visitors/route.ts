import { NextResponse } from "next/server";
import { checkRateLimit } from "@/lib/rate-limit";

const MAX_VISITORS = 5_000;

const activeVisitors = new Map<string, number>();
let totalAiChats = 0;

const VISITOR_TIMEOUT_MS = 5 * 60 * 1000; // 5 min idle

function getActiveCount() {
  const now = Date.now();
  for (const [id, ts] of activeVisitors) {
    if (now - ts > VISITOR_TIMEOUT_MS) activeVisitors.delete(id);
  }
  return activeVisitors.size;
}

// GET: SSE stream, respects client disconnect via AbortSignal
export async function GET(req: Request) {
  const encoder = new TextEncoder();
  const signal = req.signal;

  const stream = new ReadableStream({
    start(controller) {
      function send() {
        if (signal.aborted) return;
        try {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ online: getActiveCount(), chats: totalAiChats })}\n\n`,
            ),
          );
        } catch {}
      }

      send();
      const interval = setInterval(send, 15000);

      // Clean up when client disconnects
      signal.addEventListener("abort", () => {
        clearInterval(interval);
        try { controller.close(); } catch {}
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Hint to proxies not to buffer
      "X-Accel-Buffering": "no",
    },
  });
}

export async function POST(req: Request) {
  const rateLimited = checkRateLimit(req, "visitors", { windowMs: 60_000, maxRequests: 60 });
  if (rateLimited) return rateLimited;

  try {
    const body = await req.json();
    const { visitorId, action } = body as { visitorId?: string; action?: string };

    if (action === "chat") {
      totalAiChats += 1;
    } else if (visitorId && typeof visitorId === "string" && visitorId.length <= 64) {
      if (!activeVisitors.has(visitorId) && activeVisitors.size >= MAX_VISITORS) {
        getActiveCount();
      }
      if (activeVisitors.size < MAX_VISITORS || activeVisitors.has(visitorId)) {
        activeVisitors.set(visitorId, Date.now());
      }
    }

    return NextResponse.json({ online: getActiveCount(), chats: totalAiChats });
  } catch {
    return NextResponse.json(
      { error: "invalid request" },
      { status: 400 },
    );
  }
}
