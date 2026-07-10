"use client";

import { siteIdentity, siteUrlForDisplay } from "@ai-site/content";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";

// ─── Types ───────────────────────────────────────────────────────────────────

type LineType = "input" | "output" | "error" | "ai" | "system" | "blank";

interface TerminalLine {
  content: string;
  id: string;
  streaming?: boolean;
  type: LineType;
}

// ─── Built-in command responses ──────────────────────────────────────────────

const BOOT_LINES = [
  { type: "system" as LineType, content: "  █████╗ ██╗    ███████╗██╗████████╗███████╗" },
  { type: "system" as LineType, content: " ██╔══██╗██║    ██╔════╝██║╚══██╔══╝██╔════╝" },
  { type: "system" as LineType, content: " ███████║██║    ███████╗██║   ██║   █████╗  " },
  { type: "system" as LineType, content: " ██╔══██║██║    ╚════██║██║   ██║   ██╔══╝  " },
  { type: "system" as LineType, content: " ██║  ██║██║    ███████║██║   ██║   ███████╗" },
  { type: "system" as LineType, content: " ╚═╝  ╚═╝╚═╝    ╚══════╝╚═╝   ╚═╝   ╚══════╝" },
  { type: "blank" as LineType, content: "" },
  { type: "system" as LineType, content: " EVOFLOW  SITE  v1 — Marketing shell" },
  {
    type: "output" as LineType,
    content: ` Copyright (c) ${new Date().getFullYear()} ${siteIdentity.publisherName} · ${siteUrlForDisplay()}`,
  },
  { type: "system" as LineType, content: "─────────────────────────────────────────────────" },
  { type: "output" as LineType, content: " [boot]  Loading site content...        ✓" },
  { type: "output" as LineType, content: " [boot]  Command routing ready...        ✓" },
  { type: "output" as LineType, content: " [boot]  No cloud chat backend (by design) ✓" },
  { type: "system" as LineType, content: "─────────────────────────────────────────────────" },
  { type: "output" as LineType, content: ' Type "help" for available commands. Tab to autocomplete.' },
  { type: "blank" as LineType, content: "" },
];

const HELP_TEXT = [
  { type: "system" as LineType, content: "AVAILABLE COMMANDS" },
  { type: "system" as LineType, content: "─────────────────────────────────────────────────" },
  { type: "output" as LineType, content: "  about / whoami     — EvoFlow product one-pager" },
  { type: "output" as LineType, content: "  projects / ls      — list projects" },
  { type: "output" as LineType, content: "  skills / stack     — tech stack overview" },
  { type: "output" as LineType, content: "  status             — current platform build status" },
  { type: "output" as LineType, content: "  contact / email    — contact information" },
  { type: "output" as LineType, content: "  goto <path>        — navigate to a page" },
  { type: "output" as LineType, content: "  github             — open main repository" },
  { type: "output" as LineType, content: "  clear / cls        — clear the terminal" },
  { type: "output" as LineType, content: "  (unknown input)    — not routed to any AI API" },
  { type: "blank" as LineType, content: "" },
];

const ABOUT_TEXT = [
  { type: "system" as LineType, content: "PROFILE: evoflow.json" },
  { type: "system" as LineType, content: "─────────────────────────────────────────────────" },
  { type: "output" as LineType, content: '  name:       "EvoFlow"' },
  { type: "output" as LineType, content: '  role:       "Super-agent orchestration framework"' },
  { type: "output" as LineType, content: '  upstream:   "DeerFlow 2.0 lineage"' },
  { type: "output" as LineType, content: '  focus:      "Orchestration · Skills · Sandbox · Memory"' },
  { type: "output" as LineType, content: '  repo:       "github.com/EvovexAI/EvoFlow"' },
  { type: "blank" as LineType, content: "" },
];

const PROJECTS_TEXT = [
  { type: "system" as LineType, content: "HIGHLIGHTS" },
  { type: "system" as LineType, content: "─────────────────────────────────────────────────" },
  { type: "output" as LineType, content: "  [1] evoflow-core     Multi-agent orchestration" },
  { type: "output" as LineType, content: "  [2] evoflow         Desktop client surface" },
  { type: "output" as LineType, content: "  [3] skills-ecosystem MCP + pluggable skills" },
  { type: "blank" as LineType, content: "" },
  { type: "output" as LineType, content: '  Run "goto home", "goto scenarios", or "goto about" from this shell.' },
  { type: "blank" as LineType, content: "" },
];

const SKILLS_TEXT = [
  { type: "system" as LineType, content: "STACK SNAPSHOT" },
  { type: "system" as LineType, content: "─────────────────────────────────────────────────" },
  { type: "output" as LineType, content: "  Site       Next.js 16 · React 19 · Tailwind 4" },
  { type: "output" as LineType, content: "  Product    Python agent runtime · TS tooling" },
  { type: "output" as LineType, content: "  Desktop    EvoFlow (Tauri) where applicable" },
  { type: "output" as LineType, content: "  Ops        Docker · CI · 可观测流水线" },
  { type: "blank" as LineType, content: "" },
];

const CONTACT_TEXT = [
  { type: "system" as LineType, content: "CONTACT" },
  { type: "system" as LineType, content: "─────────────────────────────────────────────────" },
  { type: "output" as LineType, content: `  publisher: ${siteIdentity.publisherName}` },
  { type: "output" as LineType, content: `  email:      ${siteIdentity.contactEmail}` },
  { type: "output" as LineType, content: `  site:       ${siteUrlForDisplay()}` },
  { type: "output" as LineType, content: "  source:    顶栏「GitHub」→ Issue / 发行说明 / 仓库" },
  { type: "blank" as LineType, content: "" },
  { type: "output" as LineType, content: '  Tip: use Cmd+K for the marketing command palette.' },
  { type: "blank" as LineType, content: "" },
];

const STATUS_TEXT = [
  { type: "system" as LineType, content: "SITE STATUS" },
  { type: "system" as LineType, content: "─────────────────────────────────────────────────" },
  { type: "output" as LineType, content: "  [✓] Homepage          live (matrix + scenarios + arch)" },
  { type: "output" as LineType, content: "  [✓] About / Evolution live" },
  { type: "output" as LineType, content: "  [✓] Command palette   navigation only" },
  { type: "output" as LineType, content: "  [✓] Terminal          live · you are here" },
  { type: "output" as LineType, content: "  [—] Visitor chat      intentionally disabled" },
  { type: "blank" as LineType, content: "" },
  { type: "output" as LineType, content: "  Runtime:   编排 · 沙箱 · 记忆 · Skills / MCP（详见首页能力矩阵）" },
  { type: "blank" as LineType, content: "" },
];

const GOTO_ROUTES: Record<string, string> = {
  home: "/",
  "/": "/",
  about: "/about",
  "/about": "/about",
  capabilities: "/#capabilities",
  scenarios: "/#scenarios",
  evolution: "/evolution",
  "/evolution": "/evolution",
  lab: "/lab",
  "/lab": "/lab",
  terminal: "/terminal",
  "/terminal": "/terminal",
};

function createId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function makeLines(defs: { type: LineType; content: string }[]): TerminalLine[] {
  return defs.map((d) => ({ ...d, id: createId() }));
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function TerminalPage() {
  const router = useRouter();
  const [lines, setLines] = useState<TerminalLine[]>([]);
  const [input, setInput] = useState("");
  const [booted, setBooted] = useState(false);

  const historyRef = useRef<string[]>([]);
  const historyIdxRef = useRef<number>(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const outputRef = useRef<HTMLDivElement>(null);

  const prompt = "user@evoflow:~$";

  const appendLines = useCallback((newLines: TerminalLine[]) => {
    setLines((prev) => [...prev, ...newLines]);
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = outputRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  useEffect(() => { scrollToBottom(); }, [lines, scrollToBottom]);

  // Animated boot sequence
  useEffect(() => {
    if (booted) return;
    const bootLines = makeLines(BOOT_LINES);
    let i = 0;
    let cancelled = false;
    const getDelay = (idx: number) => idx < 6 ? 40 : idx < 8 ? 60 : 120;
    const showNext = () => {
      if (cancelled) return;
      if (i >= bootLines.length) { setBooted(true); return; }
      // Capture the value NOW before incrementing — callbacks close over the variable,
      // so we must snapshot it before i++ or React's deferred callback will read the wrong index.
      const line = bootLines[i];
      const delay = getDelay(i);
      i++;
      setLines((prev) => [...prev, line]);
      setTimeout(showNext, delay);
    };
    const t = setTimeout(showNext, 80);
    return () => { cancelled = true; clearTimeout(t); };
  }, [booted]);

  // Auto-focus input
  useEffect(() => {
    if (booted) inputRef.current?.focus();
  }, [booted]);

  // ESC to exit
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") router.back();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router]);


  const processCommand = useCallback((raw: string) => {
    const cmd = raw.trim();
    if (!cmd) return;

    // Echo input
    appendLines([{ content: `${prompt} ${cmd}`, id: createId(), type: "input" }]);

    // History
    historyRef.current = [cmd, ...historyRef.current.slice(0, 49)];
    historyIdxRef.current = -1;

    const lower = cmd.toLowerCase();
    const parts = lower.split(/\s+/);
    const verb = parts[0];
    const args = parts.slice(1);

    if (verb === "clear" || verb === "cls") {
      setLines([]);
      return;
    }

    if (verb === "help" || verb === "?") {
      appendLines(makeLines(HELP_TEXT));
      return;
    }

    if (verb === "about" || verb === "whoami" || verb === "me") {
      appendLines(makeLines(ABOUT_TEXT));
      return;
    }

    if (verb === "projects" || verb === "ls") {
      appendLines(makeLines(PROJECTS_TEXT));
      return;
    }

    if (verb === "skills" || verb === "stack" || verb === "tech") {
      appendLines(makeLines(SKILLS_TEXT));
      return;
    }

    if (verb === "contact" || verb === "email") {
      appendLines(makeLines(CONTACT_TEXT));
      return;
    }

    if (verb === "status") {
      appendLines(makeLines(STATUS_TEXT));
      return;
    }

    if (verb === "github" || verb === "repo") {
      appendLines(makeLines([
        { type: "output", content: "Opening https://github.com/EvovexAI/EvoFlow ..." },
        { type: "blank", content: "" },
      ]));
      window.open("https://github.com/EvovexAI/EvoFlow", "_blank", "noopener,noreferrer");
      return;
    }

    if (verb === "goto" || verb === "cd" || verb === "nav") {
      const target = args[0] ?? "";
      const route = GOTO_ROUTES[target];
      if (route) {
        appendLines(makeLines([
          { type: "output", content: `Navigating to ${route}...` },
          { type: "blank", content: "" },
        ]));
        setTimeout(() => router.push(route), 600);
      } else {
        appendLines(makeLines([
          { type: "error", content: `Unknown route: "${target}"` },
          { type: "output", content: "  Try: home, about, evolution, lab, terminal" },
          { type: "blank", content: "" },
        ]));
      }
      return;
    }

    if (verb === "exit" || verb === "quit" || verb === "back") {
      appendLines(makeLines([
        { type: "output", content: "Closing terminal session..." },
        { type: "blank", content: "" },
      ]));
      setTimeout(() => router.back(), 400);
      return;
    }

    if (verb === "sudo") {
      appendLines(makeLines([
        { type: "error", content: "Permission denied. (Marketing shell — not a privileged host.)" },
        { type: "blank", content: "" },
      ]));
      return;
    }

    if (verb === "version" || verb === "ver" || verb === "uname") {
      appendLines(makeLines([
        { type: "output", content: "EvoFlow site shell · Next.js 16 · TypeScript" },
        { type: "blank", content: "" },
      ]));
      return;
    }

    if (verb === "stop" || verb === "^c") {
      appendLines(makeLines([
        { type: "system", content: "^C" },
        { type: "blank", content: "" },
      ]));
      return;
    }

    appendLines(makeLines([
      { type: "error", content: `Unknown command: "${cmd}"` },
      { type: "output", content: '  This terminal does not proxy to an AI API. Type "help".' },
      { type: "blank", content: "" },
    ]));
  }, [appendLines, router]);

  // ─── Input handling ───────────────────────────────────────────────────────

  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const cmd = input;
      setInput("");
      processCommand(cmd);
      return;
    }

    if (e.key === "ArrowUp") {
      e.preventDefault();
      const next = Math.min(historyIdxRef.current + 1, historyRef.current.length - 1);
      historyIdxRef.current = next;
      setInput(historyRef.current[next] ?? "");
      return;
    }

    if (e.key === "ArrowDown") {
      e.preventDefault();
      const next = historyIdxRef.current - 1;
      historyIdxRef.current = next;
      setInput(next < 0 ? "" : (historyRef.current[next] ?? ""));
      return;
    }

    if (e.key === "c" && e.ctrlKey) {
      e.preventDefault();
      appendLines(makeLines([
        { type: "system", content: "^C" },
        { type: "blank", content: "" },
      ]));
      setInput("");
      return;
    }

    if (e.key === "l" && e.ctrlKey) {
      e.preventDefault();
      setLines([]);
      return;
    }

    if (e.key === "Tab") {
      e.preventDefault();
      const commands = [
        "help",
        "about",
        "projects",
        "skills",
        "contact",
        "status",
        "github",
        "goto ",
        "goto scenarios",
        "goto capabilities",
        "clear",
        "version",
      ];
      const match = commands.find((c) => c.startsWith(input.toLowerCase()));
      if (match) setInput(match);
      return;
    }
  }, [appendLines, input, processCommand]);

  const lineColor = useMemo(() => ({
    input: "text-white/90",
    output: "text-[#a8ffc0]/80",
    error: "text-red-400/90",
    ai: "text-[#c8e6ff]/85",
    system: "text-[#00ff50]/70",
    blank: "",
  }), []);

  return (
    <div
      className="relative flex h-screen flex-col overflow-hidden bg-black font-mono"
      onClick={() => inputRef.current?.focus()}
    >
      {/* Scanlines */}
      <div
        className="pointer-events-none absolute inset-0 z-10 opacity-[0.025]"
        style={{
          backgroundImage: "repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,255,80,0.2) 2px, rgba(0,255,80,0.2) 4px)",
        }}
      />

      {/* Top bar */}
      <div className="z-20 flex shrink-0 items-center justify-between border-b border-[#00ff50]/10 bg-[#000d00]/80 px-5 py-2.5 backdrop-blur-sm">
        <div className="flex items-center gap-3">
          <div className="flex gap-1.5">
            <button
              className="group relative h-2.5 w-2.5 rounded-full bg-red-500/70 transition-colors hover:bg-red-400"
              onClick={() => router.back()}
              title="Close (ESC)"
              type="button"
            >
              <span className="absolute inset-0 flex items-center justify-center text-[7px] font-bold text-red-900 opacity-0 group-hover:opacity-100">✕</span>
            </button>
            <div className="h-2.5 w-2.5 rounded-full bg-yellow-500/70" />
            <div className="h-2.5 w-2.5 rounded-full bg-[#00ff50]/70" />
          </div>
          <span className="text-[11px] uppercase tracking-[0.3em] text-[#00ff50]/50">
            user@evovex — terminal
          </span>
        </div>
        <div className="flex items-center gap-4 text-[10px] text-[#00ff50]/30">
          <span>site-shell</span>
          <span className="flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-[#00ff50]/60" />
            ready
          </span>
        </div>
      </div>

      {/* Output area */}
      <div
        className="z-20 flex-1 overflow-y-auto px-5 py-4"
        ref={outputRef}
        style={{ scrollbarWidth: "thin", scrollbarColor: "#00ff50/20 transparent" }}
      >
        {lines.map((line) => {
          // Defensive guard: skip any undefined entries (should not happen after the boot-sequence fix)
          if (!line) return null;
          return (
            <div
              className={["whitespace-pre-wrap break-words text-[13px] leading-6", lineColor[line.type]].join(" ")}
              key={line.id}
            >
              {line.type === "blank" ? "\u00a0" : line.content}
              {line.streaming && line.content.length > 0 && (
                <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-[blink_0.7s_step-end_infinite] bg-[#c8e6ff]/80" />
              )}
            </div>
          );
        })}

        {/* Input line */}
        <div className="mt-1 flex items-center gap-2">
          <span className="shrink-0 text-[13px] leading-6 text-[#00ff50]/70">{prompt}</span>
          <div className="relative flex-1">
            <input
              className="w-full bg-transparent text-[13px] leading-6 text-white/90 caret-[#00ff50] outline-none"
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              ref={inputRef}
              spellCheck={false}
              type="text"
              value={input}
              aria-label="Terminal input"
            />
          </div>
        </div>
      </div>

      {/* Bottom hint */}
      <div className="z-20 shrink-0 border-t border-[#00ff50]/10 bg-[#000d00]/60 px-5 py-2">
        <p className="text-[10px] tracking-[0.22em] text-[#00ff50]/25">
          Tab: autocomplete · ↑↓: history · Ctrl+C: stop · Ctrl+L: clear · ESC / exit: close
        </p>
      </div>
    </div>
  );
}
