import { NextResponse } from "next/server";
import { checkRateLimit } from "@/lib/rate-limit";

const MAX_CURSORS = 500;

interface CursorEntry {
  id: string;
  x: number;
  y: number;
  name: string;
  color: string;
  page: string;
  lastSeen: number;
}

const cursors = new Map<string, CursorEntry>();
const CURSOR_TIMEOUT_MS = 8_000;
const SSE_INTERVAL_MS = 80;

const ADJECTIVES = [
  "Swift", "Bold", "Calm", "Keen", "Wise",
  "Brave", "Sly", "Wild", "Zen", "Agile",
  "Neo", "Vivid", "Lucid", "Flux", "Rapid",
];
const ANIMALS = [
  "Fox", "Owl", "Wolf", "Lynx", "Hawk",
  "Puma", "Crane", "Raven", "Falcon", "Otter",
  "Tiger", "Viper", "Eagle", "Bear", "Heron",
];
const CURSOR_COLORS = [
  "#d0bcff", "#5de6ff", "#ffb95f", "#ff6b8a", "#7dd3fc",
  "#a3e635", "#f9a8d4", "#fbbf24", "#67e8f9", "#c4b5fd",
];

function cleanStale() {
  const now = Date.now();
  for (const [id, entry] of cursors) {
    if (now - entry.lastSeen > CURSOR_TIMEOUT_MS) cursors.delete(id);
  }
}

function getSnapshot(excludeId?: string): CursorEntry[] {
  cleanStale();
  const result: CursorEntry[] = [];
  for (const [, entry] of cursors) {
    if (entry.id !== excludeId) result.push(entry);
  }
  return result;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const viewerId = url.searchParams.get("id") ?? "";
  const encoder = new TextEncoder();
  const signal = req.signal;

  const stream = new ReadableStream({
    start(controller) {
      function send() {
        if (signal.aborted) return;
        try {
          const data = getSnapshot(viewerId);
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(data)}\n\n`),
          );
        } catch { /* client gone */ }
      }

      send();
      const interval = setInterval(send, SSE_INTERVAL_MS);

      signal.addEventListener("abort", () => {
        clearInterval(interval);
        if (viewerId) cursors.delete(viewerId);
        try { controller.close(); } catch {}
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

export async function POST(req: Request) {
  const rateLimited = checkRateLimit(req, "cursors", { windowMs: 10_000, maxRequests: 200 });
  if (rateLimited) return rateLimited;

  try {
    const body = (await req.json()) as {
      id?: string;
      x?: number;
      y?: number;
      page?: string;
    };

    if (
      !body.id ||
      typeof body.id !== "string" ||
      body.id.length > 64 ||
      typeof body.x !== "number" ||
      typeof body.y !== "number"
    ) {
      return NextResponse.json({ error: "invalid" }, { status: 400 });
    }

    const existing = cursors.get(body.id);
    if (existing) {
      existing.x = body.x;
      existing.y = body.y;
      existing.page = body.page ?? existing.page;
      existing.lastSeen = Date.now();
    } else {
      if (cursors.size >= MAX_CURSORS) {
        cleanStale();
        if (cursors.size >= MAX_CURSORS) {
          return NextResponse.json({ error: "too_many_cursors" }, { status: 429 });
        }
      }
      const adjIdx = Math.floor(Math.random() * ADJECTIVES.length);
      const aniIdx = Math.floor(Math.random() * ANIMALS.length);
      const colIdx = Math.floor(Math.random() * CURSOR_COLORS.length);
      cursors.set(body.id, {
        id: body.id,
        x: body.x,
        y: body.y,
        name: `${ADJECTIVES[adjIdx]} ${ANIMALS[aniIdx]}`,
        color: CURSOR_COLORS[colIdx],
        page: body.page ?? "/",
        lastSeen: Date.now(),
      });
    }

    return NextResponse.json({ ok: true, count: cursors.size });
  } catch {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
}
