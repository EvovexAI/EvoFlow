"use client";

import { useEffect, useRef, useState } from "react";

export interface VisitorStats {
  online: number;
  chats: number;
}

let cachedVisitorId: string | null = null;

function getVisitorId(): string {
  if (cachedVisitorId) return cachedVisitorId;
  if (typeof window === "undefined") return "server";
  let id = localStorage.getItem("_vid");
  if (!id) {
    id = Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem("_vid", id);
  }
  cachedVisitorId = id;
  return id;
}

function pingVisitor(vid: string): Promise<VisitorStats> {
  return fetch("/api/visitors", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ visitorId: vid }),
  })
    .then((r) => r.json() as Promise<VisitorStats>)
    .catch(() => ({ online: 1, chats: 0 }));
}

export function useVisitorCounter() {
  const [stats, setStats] = useState<VisitorStats>({ online: 1, chats: 0 });
  const pingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const unmountedRef = useRef(false);

  useEffect(() => {
    unmountedRef.current = false;
    const vid = getVisitorId();

    // Initial ping
    pingVisitor(vid).then((d) => {
      if (!unmountedRef.current) setStats(d);
    });

    // Keepalive ping every 2 minutes
    pingIntervalRef.current = setInterval(() => {
      pingVisitor(vid).then((d) => {
        if (!unmountedRef.current) setStats(d);
      });
    }, 2 * 60 * 1000);

    // SSE with exponential-backoff reconnect
    let retryDelay = 3000;

    function connect() {
      if (unmountedRef.current) return;
      if (typeof EventSource === "undefined") return;

      const es = new EventSource("/api/visitors");
      esRef.current = es;

      es.onmessage = (e) => {
        retryDelay = 3000; // reset on successful message
        try {
          const d = JSON.parse(e.data) as VisitorStats;
          if (!unmountedRef.current) setStats(d);
        } catch {}
      };

      es.onerror = () => {
        es.close();
        esRef.current = null;
        if (unmountedRef.current) return;
        // Exponential backoff: 3s → 6s → 12s → 30s cap
        reconnectTimerRef.current = setTimeout(() => {
          retryDelay = Math.min(retryDelay * 2, 30000);
          connect();
        }, retryDelay);
      };
    }

    connect();

    return () => {
      unmountedRef.current = true;
      if (pingIntervalRef.current) clearInterval(pingIntervalRef.current);
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      esRef.current?.close();
      esRef.current = null;
    };
  }, []);

  return stats;
}

export function recordAiChat() {
  fetch("/api/visitors", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "chat" }),
  }).catch(() => {});
}
