/* eslint-disable max-lines -- 终端 resize 调度需要和 xterm/PTY 生命周期放在同一组件内，避免拖拽状态、fit、后端 resize 队列拆散后出现竞态。*/
import { ClipboardAddon } from "@xterm/addon-clipboard";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import { ClipboardPaste, Copy } from "lucide-react";
import { useCallback, useEffect, useRef } from "react";
import type { ILink, ILinkHandler, ITheme, IWindowsPty } from "@xterm/xterm";
import type { IServiceAccessor } from "@zcode/services";
import type { IDisposable } from "@zcode/rpc";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu.js";
import {
  createPendingTerminalInputFallback,
  consumeTerminalInputFallbackHandledData,
  createTerminalInputFallbackKeydownCandidate,
  markTerminalInputFallbackHandled,
  recordTerminalInputFallbackHandledData,
  recordTerminalInputFallbackRecentData,
  resolveTerminalInputFallbackAction,
  type PendingTerminalInputFallback,
  type TerminalInputFallbackKeydownCandidate,
  type TerminalInputFallbackHandledData,
} from "@/terminal/terminalComposedInputFallback.js";
import { normalizePowerShellReadlineRedraw } from "@/terminal/terminalDataTransform.js";
import { getHttpLinksForTerminalBufferLine } from "@/terminal/terminalLinks.js";
import { mergeTerminalTheme } from "@/terminal/terminalTheme.js";
import {
  sidePaneTerminalSessionRegistry,
  type SidePaneTerminalSessionEntry,
} from "@/terminal/sidePaneTerminalSessionRegistry.js";

const DEFAULT_TERMINAL_FONT_FAMILY =
  "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Monaco, Consolas, 'Cascadia Mono', 'JetBrains Mono', 'MesloLGS NF', 'Hack Nerd Font', monospace";
const TERMINAL_RESIZE_DRAG_THROTTLE_MS = 300;
const TERMINAL_INPUT_FALLBACK_RECENT_DATA_MS = 150;
const TERMINAL_INPUT_FALLBACK_KEYDOWN_INPUT_MS = 40;
const TERMINAL_INPUT_FALLBACK_FLUSH_DELAY_MS = 150;

type TerminalResizeReason = "drag" | "final" | "visible" | "init" | "observer";

type TerminalSize = {
  cols: number;
  rows: number;
};

function normalizeWindowsPtyOption(windowsPty: IWindowsPty | undefined): IWindowsPty | undefined {
  if (!windowsPty) return undefined;
  return windowsPty.buildNumber
    ? { backend: windowsPty.backend, buildNumber: windowsPty.buildNumber }
    : { backend: windowsPty.backend };
}

function normalizeTerminalFontSize(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 6 || value > 72) {
    return undefined;
  }
  return value;
}

function formatShellLabel(shell: string | null): string | null {
  if (!shell) {
    return null;
  }

  const shellParts = shell.split(/[\\/]/);
  const lastPart = shellParts[shellParts.length - 1];
  const name = lastPart?.replace(/\.exe$/i, "").toLowerCase();
  if (!name) {
    return shell;
  }
  if (name === "powershell" || name === "pwsh") {
    return "PowerShell";
  }
  return name;
}

function isHttpTerminalUrl(text: string): boolean {
  return /^https?:\/\//i.test(text);
}

export function TerminalSession({
  sessionId,
  services,
  cwd,
  isVisible,
  isPanelResizing = false,
  isWindowsDesktop = false,
  onShellLabelChange,
  onExit,
  onOpenBrowserUrl,
  persistentKey,
  workspaceKey,
}: {
  sessionId: string;
  services: IServiceAccessor;
  cwd?: string;
  isVisible: boolean;
  isPanelResizing?: boolean;
  isWindowsDesktop?: boolean;
  onShellLabelChange: (sessionId: string, shellLabel: string | null) => void;
  onExit?: (sessionId: string, exitCode: number) => void;
  onOpenBrowserUrl: (url: string) => void;
  /**
   * 跨组件生命周期的会话复用 key（仅 side pane terminal 用）。
   * 传入后 xterm 实例 + PTY 所有权上移到 sidePaneTerminalSessionRegistry 模块级单例，
   * 组件卸载只 detach DOM、不 dispose；重挂按 key 复用，scrollback 历史跨 workspace 保活。
   * 不传（下侧 terminal）走原 effect 路径，字节级不变。
   */
  persistentKey?: string;
  /**
   * workspace 身份隔离 key（= workspaceIdentity?.trim() || workspacePath）。
   * 仅 persistentKey 路径用：写入 registry entry.workspaceKey，
   * 供 workspace tab 真正关闭时按 workspaceKey 批量回收 PTY（对称下侧 openWorkspaceKeys 回收）。
   * 不传时 fallback 到 cwd。下侧 terminal 不传 persistentKey，此值不生效。
   */
  workspaceKey?: string;
}) {
  const { intl } = useZCodeIntl();
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const terminalIdRef = useRef<string | undefined>(undefined);
  const isVisibleRef = useRef(isVisible);
  const resizeRAFRef = useRef(0);
  const resizeThrottleTimerRef = useRef<number | null>(null);
  const isPanelResizingRef = useRef(isPanelResizing);
  const resizeRequestStatsRef = useRef({ fit: 0, queued: 0, sent: 0, skipped: 0 });
  const lastSentTerminalSizeRef = useRef<TerminalSize | null>(null);
  const pendingTerminalSizeRef = useRef<TerminalSize | null>(null);
  const resizeInFlightRef = useRef(false);
  const focusRAFRef = useRef(0);
  const exitedMessageRef = useRef("");
  const exitHandlerRef = useRef(onExit);
  const openBrowserUrlRef = useRef(onOpenBrowserUrl);
  const terminalProfileThemeRef = useRef<ITheme | undefined>(undefined);
  const pendingInputFallbacksRef = useRef<PendingTerminalInputFallback[]>([]);
  const inputFallbackKeydownCandidateRef = useRef<TerminalInputFallbackKeydownCandidate | null>(
    null,
  );
  const recentInputFallbackHandledDataRef = useRef<TerminalInputFallbackHandledData[]>([]);

  exitedMessageRef.current = intl.formatMessage({ id: "terminal.exited" });
  exitHandlerRef.current = onExit;
  openBrowserUrlRef.current = onOpenBrowserUrl;

  const flushTerminalServiceResize = useCallback(() => {
    if (resizeInFlightRef.current) {
      return;
    }

    const terminalId = terminalIdRef.current;
    const pendingSize = pendingTerminalSizeRef.current;
    if (!terminalId || !pendingSize) {
      return;
    }

    pendingTerminalSizeRef.current = null;
    resizeInFlightRef.current = true;
    resizeRequestStatsRef.current.sent += 1;

    const startedAt = performance.now();
    void services.terminalService
      .resize({
        id: terminalId,
        cols: pendingSize.cols,
        rows: pendingSize.rows,
      })
      .then(() => {
        logger.debug("[Terminal] resize sent", {
          cols: pendingSize.cols,
          durationMs: Math.round(performance.now() - startedAt),
          fitCount: resizeRequestStatsRef.current.fit,
          queuedCount: resizeRequestStatsRef.current.queued,
          rows: pendingSize.rows,
          sentCount: resizeRequestStatsRef.current.sent,
          skippedCount: resizeRequestStatsRef.current.skipped,
          terminalId,
          terminalTabId: sessionId,
        });
      })
      .catch((error) => {
        logger.warn("[Terminal] resize failed:", error);
      })
      .finally(() => {
        resizeInFlightRef.current = false;
        if (pendingTerminalSizeRef.current) {
          flushTerminalServiceResize();
        }
      });
  }, [services.terminalService, sessionId]);

  const queueTerminalServiceResize = useCallback(
    (size: TerminalSize) => {
      const lastSentSize = lastSentTerminalSizeRef.current;
      const pendingSize = pendingTerminalSizeRef.current;
      if (
        (lastSentSize?.cols === size.cols && lastSentSize.rows === size.rows && !pendingSize) ||
        (pendingSize?.cols === size.cols && pendingSize.rows === size.rows)
      ) {
        resizeRequestStatsRef.current.skipped += 1;
        return;
      }

      pendingTerminalSizeRef.current = size;
      lastSentTerminalSizeRef.current = size;
      resizeRequestStatsRef.current.queued += 1;
      flushTerminalServiceResize();
    },
    [flushTerminalServiceResize],
  );

  const clearResizeThrottleTimer = useCallback(() => {
    if (resizeThrottleTimerRef.current) {
      window.clearTimeout(resizeThrottleTimerRef.current);
      resizeThrottleTimerRef.current = null;
    }
  }, []);

  const requestFitAndResize = useCallback(
    (reason: TerminalResizeReason = "observer") => {
      if (resizeRAFRef.current) {
        cancelAnimationFrame(resizeRAFRef.current);
      }

      resizeRAFRef.current = requestAnimationFrame(() => {
        resizeRAFRef.current = 0;
        const el = containerRef.current;
        const term = termRef.current;
        const fitAddon = fitAddonRef.current;
        if (
          !isVisibleRef.current ||
          !el ||
          !term ||
          !fitAddon ||
          el.clientWidth <= 0 ||
          el.clientHeight <= 0
        ) {
          return;
        }

        try {
          resizeRequestStatsRef.current.fit += 1;
          fitAddon.fit();
        } catch (error) {
          logger.warn("[Terminal] fit failed:", error);
          return;
        }

        logger.debug("[Terminal] fit requested resize", {
          cols: term.cols,
          reason,
          resizing: isPanelResizingRef.current,
          rows: term.rows,
          terminalId: terminalIdRef.current,
          terminalTabId: sessionId,
        });
        queueTerminalServiceResize({ cols: term.cols, rows: term.rows });
      });
    },
    [queueTerminalServiceResize, sessionId],
  );

  const scheduleFitAndResize = useCallback(
    (reason: TerminalResizeReason = "observer") => {
      if (!isPanelResizingRef.current || reason === "final") {
        clearResizeThrottleTimer();
        requestFitAndResize(reason);
        return;
      }

      if (resizeThrottleTimerRef.current) {
        return;
      }

      // 拖动终端高度时 ResizeObserver 会按布局帧连续触发。
      // xterm fit + PTY resize 是同步布局和跨进程请求组合，拖拽中只按常量低频预览，松手后再 flush 最终尺寸。
      resizeThrottleTimerRef.current = window.setTimeout(() => {
        resizeThrottleTimerRef.current = null;
        requestFitAndResize("drag");
      }, TERMINAL_RESIZE_DRAG_THROTTLE_MS);
    },
    [clearResizeThrottleTimer, requestFitAndResize],
  );

  const requestFocus = useCallback(() => {
    if (focusRAFRef.current) {
      cancelAnimationFrame(focusRAFRef.current);
    }

    focusRAFRef.current = requestAnimationFrame(() => {
      focusRAFRef.current = 0;
      const term = termRef.current;
      if (!isVisibleRef.current || !term) {
        return;
      }

      // 打开/新建/切换终端时 React 只更新了可见 tab，焦点仍停在按钮或输入框。
      // xterm 的 textarea 会在 open 后创建，所以要等下一帧确认当前 session 仍可见再聚焦。
      term.focus();
      logger.debug("[Terminal] focused visible terminal", {
        terminalId: terminalIdRef.current,
        terminalTabId: sessionId,
      });
    });
  }, [sessionId]);

  useEffect(() => {
    isVisibleRef.current = isVisible;
    if (isVisible) {
      scheduleFitAndResize("visible");
      requestFocus();
    }
  }, [isVisible, requestFocus, scheduleFitAndResize]);

  useEffect(() => {
    const wasResizing = isPanelResizingRef.current;
    isPanelResizingRef.current = isPanelResizing;
    if (wasResizing && !isPanelResizing && isVisibleRef.current) {
      scheduleFitAndResize("final");
    }
  }, [isPanelResizing, scheduleFitAndResize]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    // ===== persistentKey 路径：side pane terminal 跨 workspace 会话保活 =====
    // xterm 实例 + PTY 所有权上移到 sidePaneTerminalSessionRegistry 模块级单例，
    // 组件卸载只 detach DOM、不 dispose；重挂按 persistentKey 复用，scrollback 跨 workspace 保活。
    // 原路径（下侧 terminal，不传 persistentKey）字节级不变。
    if (persistentKey) {
      terminalProfileThemeRef.current = undefined;
      const existingEntry = sidePaneTerminalSessionRegistry.get(persistentKey);

      // --- 复用快路径：切回 workspace / 重挂，entry 已在 registry ---
      if (existingEntry) {
        termRef.current = existingEntry.term;
        fitAddonRef.current = existingEntry.fitAddon;
        terminalIdRef.current = existingEntry.terminalId || undefined;
        el.appendChild(existingEntry.hostEl);
        const reuseThemeObserver = new MutationObserver(() => {
          // 从 entry.profileTheme 读：重挂后组件局部 ref 已重置为 undefined，
          // profile theme 只存在于 registry entry，必须从 entry 取（否则丢用户配置的终端颜色）。
          existingEntry.term.options.theme = mergeTerminalTheme(existingEntry.profileTheme);
        });
        reuseThemeObserver.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ["class"],
        });
        let reuseResizeRAF = 0;
        const reuseResizeObserver = new ResizeObserver(() => {
          if (!isVisibleRef.current) return;
          if (reuseResizeRAF) cancelAnimationFrame(reuseResizeRAF);
          reuseResizeRAF = requestAnimationFrame(() => scheduleFitAndResize("observer"));
        });
        reuseResizeObserver.observe(el);
        try {
          resizeRequestStatsRef.current.fit += 1;
          existingEntry.fitAddon.fit();
        } catch (error) {
          logger.warn("[Terminal] persistent reuse fit failed:", error);
        }
        if (isVisibleRef.current) {
          requestFocus();
        }
        logger.debug("[Terminal] persistent reuse", {
          terminalTabId: sessionId,
          persistentKey,
        });
        return () => {
          reuseThemeObserver.disconnect();
          reuseResizeObserver.disconnect();
          if (reuseResizeRAF) cancelAnimationFrame(reuseResizeRAF);
          sidePaneTerminalSessionRegistry.detachDom(persistentKey);
          // 不 dispose：term/PTY/订阅都留在 registry 供下次复用
          termRef.current = null;
          fitAddonRef.current = null;
        };
      }

      // --- 首次创建：常驻 hostEl，term open 到 hostEl，资源进 registry ---
      const hostEl = document.createElement("div");
      hostEl.className = "terminal-xterm-shell h-full min-h-0 w-full overflow-hidden";
      el.appendChild(hostEl);

      let ptyCancelled = false;
      const registryDisposers: IDisposable[] = [];
      const localDisposers: IDisposable[] = [];

      const term = new XTerm({
        fontSize: 13,
        fontFamily: DEFAULT_TERMINAL_FONT_FAMILY,
        theme: mergeTerminalTheme(terminalProfileThemeRef.current),
        linkHandler: {
          allowNonHttpProtocols: false,
          activate(event, text) {
            if (!isHttpTerminalUrl(text)) return;
            event.preventDefault();
            logger.debug("[Terminal] open OSC 8 http link", { url: text });
            openBrowserUrlRef.current(text);
          },
        } satisfies ILinkHandler,
      });
      termRef.current = term;

      const fitAddon = new FitAddon();
      fitAddonRef.current = fitAddon;
      term.loadAddon(fitAddon);
      term.loadAddon(new ClipboardAddon());
      term.open(hostEl);

      let initialTerminalSize: TerminalSize | null = null;
      if (isVisibleRef.current && hostEl.clientWidth > 0 && hostEl.clientHeight > 0) {
        try {
          resizeRequestStatsRef.current.fit += 1;
          fitAddon.fit();
          initialTerminalSize = { cols: term.cols, rows: term.rows };
          lastSentTerminalSizeRef.current = initialTerminalSize;
          logger.debug("[Terminal] initial fit before create (persistent)", {
            cols: initialTerminalSize.cols,
            rows: initialTerminalSize.rows,
            terminalTabId: sessionId,
          });
        } catch (error) {
          logger.warn("[Terminal] persistent initial fit failed:", error);
        }
      }
      if (isVisibleRef.current) {
        requestFocus();
      }

      // 组件局部：customKeyEventHandler（依赖组件 inputFallback ref）
      term.attachCustomKeyEventHandler((e) => {
        if (e.type !== "keydown") return true;
        inputFallbackKeydownCandidateRef.current =
          e.metaKey || e.ctrlKey || e.altKey
            ? null
            : createTerminalInputFallbackKeydownCandidate({
                eventTimeStamp: e.timeStamp,
                key: e.key,
                now: performance.now(),
              });
        if (!(e.metaKey || e.ctrlKey)) return true;
        const key = e.key.toLowerCase();
        if (key === "c" && term.hasSelection()) {
          void navigator.clipboard.writeText(term.getSelection()).catch((err) => {
            logger.warn("[Terminal] copy via shortcut failed:", err);
          });
          return false;
        }
        if (key === "v") {
          // attachCustomKeyEventHandler 返回 false 只阻止 xterm 处理 Ctrl+V，
          // 不会取消浏览器随后派发的原生 paste 事件；这里手动 paste 一次后，
          // 原生 paste 又会被 xterm 的内置监听写入一次，导致快捷键粘贴重复。
          // 因此必须先取消默认事件，再保留手动读取剪贴板的单次写入。
          // 与原路径（下侧 terminal）字节对齐：两份拷贝曾在此漂移（persistentKey 漏了 debug 日志），
          // 待后续重构收敛为单一 wireTerminalProcessing 后此注释删除。
          e.preventDefault();
          e.stopPropagation();
          navigator.clipboard
            .readText()
            .then((text) => {
              logger.debug("[Terminal] paste via shortcut", { length: text.length });
              if (text) term.paste(text);
            })
            .catch((err) => logger.warn("[Terminal] paste via shortcut failed:", err));
          return false;
        }
        return true;
      });

      // 组件局部：主题 observer
      const themeObserver = new MutationObserver(() => {
        // 从 entry.profileTheme 读：profile theme 所有权在 registry entry，跨重挂常驻；
        // 组件局部 terminalProfileThemeRef 在重挂后会丢失 profile theme，不能作为 observer 数据源。
        term.options.theme = mergeTerminalTheme(entry.profileTheme);
      });
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class"],
      });
      localDisposers.push({ dispose: () => themeObserver.disconnect() } as IDisposable);

      // 进 registry：linkProvider（detached 时保留无害）
      registryDisposers.push(
        term.registerLinkProvider({
          provideLinks(bufferLineNumber, callback) {
            const links = getHttpLinksForTerminalBufferLine(
              term.buffer.active,
              bufferLineNumber,
              term.cols,
            )?.map(
              (link): ILink => ({
                ...link,
                activate(event, text) {
                  event.preventDefault();
                  logger.debug("[Terminal] open plain http link", { url: text });
                  openBrowserUrlRef.current(text);
                },
              }),
            );
            callback(links);
          },
        }),
      );

      // entry 先占位存入 registry（terminalId 异步填），重挂/回收据此判断
      const entry: SidePaneTerminalSessionEntry = {
        key: persistentKey,
        term,
        fitAddon,
        terminalId: "",
        cwd: cwd ?? "",
        // workspaceKey 用于 workspace tab 真正关闭时按 workspace 批量回收（对称下侧 openWorkspaceKeys）。
        workspaceKey: workspaceKey ?? cwd ?? "",
        hostEl,
        dispose: () => {}, // 紧接着补全
      };
      entry.dispose = () => {
        ptyCancelled = true;
        for (const d of registryDisposers) {
          try {
            d.dispose();
          } catch (error) {
            logger.warn("[Terminal] persistent dispose disposer failed:", error);
          }
        }
        if (entry.terminalId) {
          void services.terminalService.dispose({ id: entry.terminalId });
        }
        try {
          term.dispose();
        } catch (error) {
          logger.warn("[Terminal] persistent term.dispose failed:", error);
        }
      };
      sidePaneTerminalSessionRegistry.register(persistentKey, entry);

      // 创建 PTY（异步）
      const initialCreateSize = initialTerminalSize ?? { cols: term.cols, rows: term.rows };
      void services.terminalService
        .create({ cols: initialCreateSize.cols, rows: initialCreateSize.rows, cwd })
        .then(({ id, shell, fontFamily, fontSize, theme, fontFamilySource, windowsPty }) => {
          if (ptyCancelled) {
            // cleanup 已发生：杀掉这个孤儿 PTY，不进 entry
            void services.terminalService.dispose({ id });
            return;
          }
          entry.terminalId = id;
          terminalIdRef.current = id;
          // 与原路径对称：id ready 后立即 flush 创建期间排队的 resize（pendingTerminalSizeRef）。
          // 否则 scheduleFitAndResize("init") 会因 pendingSize 去重跳过，PTY 停在错误 cols/rows。
          flushTerminalServiceResize();
          term.options.windowsPty = normalizeWindowsPtyOption(windowsPty);
          term.options.fontFamily = fontFamily || DEFAULT_TERMINAL_FONT_FAMILY;
          const nextFontSize = normalizeTerminalFontSize(fontSize);
          if (nextFontSize) {
            term.options.fontSize = nextFontSize;
          }
          terminalProfileThemeRef.current = theme as ITheme | undefined;
          // profile theme 所有权上移到 registry entry，
          // 跨组件生命周期复用不丢（原仅写组件局部 ref，重挂后新组件 ref=undefined → 复用 observer 用 undefined 合并 → 丢失）。
          entry.profileTheme = theme as ITheme | undefined;
          term.options.theme = mergeTerminalTheme(entry.profileTheme);
          const nextShellLabel = formatShellLabel(shell);
          logger.info("[Terminal] shell resolved (persistent):", {
            cwd,
            fontFamilySource,
            shell,
            shellLabel: nextShellLabel,
            terminalId: id,
            terminalTabId: sessionId,
          });
          onShellLabelChange(sessionId, nextShellLabel);
          scheduleFitAndResize("init");
          if (isVisibleRef.current) {
            requestFocus();
          }

          // data 订阅 → term.write（进 registry，detached 时仍累积 scrollback）
          registryDisposers.push(
            services.terminalService.onDynamicData(id)((data) => {
              term.write(normalizePowerShellReadlineRedraw(data, shell));
            }),
          );
          // exit 订阅（进 registry，与原路径对称：有 onExit 则回调，否则写退出提示）
          registryDisposers.push(
            services.terminalService.onDynamicExit(id)((exitCode) => {
              const exitHandler = exitHandlerRef.current;
              logger.info("[Terminal] persistent session exited", {
                autoClose: Boolean(exitHandler),
                exitCode,
                terminalId: id,
                terminalTabId: sessionId,
              });
              if (exitHandler) {
                exitHandler(sessionId, exitCode);
                return;
              }
              // side pane Terminal 不传 onExit，保留退出提示。
              term.write(`\r\n${exitedMessageRef.current}\r\n`);
            }),
          );

          // onData（进 registry，随 term 常驻）：
          // 不能放 localDisposers：cleanup(detach) 时会被取消，而复用路径不重绑，
          // 导致切回 workspace 后 scrollback 在但无法输入交互。
          // 输入订阅生命周期必须 = entry 生命周期（随 term 常驻），detach 不取消。
          //
          // 与原路径（下侧 terminal）的 onData 完全一致：维护 keydown candidate 去重历史，
          // 供 Windows 输入法 textarea 兜底消费（IME composition committed text 的三段去重闭环）。
          // 注：本段只处理「已提交 composition 文本」的去重，与 Shift 切换输入法动作无关——
          // Shift 切换是输入法系统级行为（customKeyEventHandler 对 Shift 直接 return true 放行）；
          // 「Shift 切英文后字符丢失」的真根因是 isWindowsDesktop 未透传（已在 WorkspaceShellLayout 修复）。
          registryDisposers.push(
            term.onData((data) => {
              const now = performance.now();
              const inputFallbackKeydownCandidate = inputFallbackKeydownCandidateRef.current;
              const handledData = recordTerminalInputFallbackHandledData({
                candidate: inputFallbackKeydownCandidate,
                data,
                history: recentInputFallbackHandledDataRef.current,
                maxAgeMs: TERMINAL_INPUT_FALLBACK_RECENT_DATA_MS,
                now,
              });
              recentInputFallbackHandledDataRef.current = handledData.usedCandidate
                ? handledData.history
                : recordTerminalInputFallbackRecentData({
                    data,
                    history: handledData.history,
                    maxAgeMs: TERMINAL_INPUT_FALLBACK_RECENT_DATA_MS,
                    now,
                  });
              if (handledData.usedCandidate) {
                inputFallbackKeydownCandidateRef.current = null;
              }
              markTerminalInputFallbackHandled(pendingInputFallbacksRef.current, data);
              void services.terminalService.write({ id, data });
            }),
          );

          // Windows 输入法兜底（进 registry，随 term 常驻，与 onData 同生命周期）。
          // textarea 元素随 term 实例常驻，监听绑一次即可；detach 不取消，重挂后中文输入法兜底仍生效。
          const textarea =
            isWindowsDesktop &&
            (term as unknown as { _core: { textarea: HTMLTextAreaElement } })._core?.textarea;
          if (textarea) {
            const handleInput = (e: InputEvent) => {
              if (e.inputType !== "insertText" || !e.data || !e.composed) return;
              const insertedText = e.data;
              const now = performance.now();
              const pendingFallback = createPendingTerminalInputFallback(insertedText);
              pendingInputFallbacksRef.current.push(pendingFallback);
              consumeTerminalInputFallbackHandledData({
                history: recentInputFallbackHandledDataRef.current,
                inputEventTimeStamp: e.timeStamp,
                maxAgeMs: TERMINAL_INPUT_FALLBACK_RECENT_DATA_MS,
                maxInputDelayMs: TERMINAL_INPUT_FALLBACK_KEYDOWN_INPUT_MS,
                now,
                pending: pendingFallback,
              });
              setTimeout(() => {
                pendingInputFallbacksRef.current = pendingInputFallbacksRef.current.filter(
                  (item) => item !== pendingFallback,
                );
                // 不检查 ptyCancelled：订阅已随 entry 常驻（registryDisposers），
                // ptyCancelled 是单次 effect 闭包变量，detach 后会变 true 导致 fallback 永久失效。
                // release 时 entry.dispose 会移除本监听；PTY disposed 后 write 为 no-op，安全。
                const fallbackAction = resolveTerminalInputFallbackAction({
                  pending: pendingFallback,
                  textareaValue: textarea.value,
                });
                if (fallbackAction.shouldWrite) {
                  logger.debug("[Terminal] flush composed input fallback (persistent)", {
                    length: insertedText.length,
                    terminalId: id,
                    terminalTabId: sessionId,
                  });
                  void services.terminalService.write({ id, data: insertedText });
                }
                if (fallbackAction.shouldClearTextarea) {
                  textarea.value = "";
                }
              }, TERMINAL_INPUT_FALLBACK_FLUSH_DELAY_MS);
            };
            // [evoflow-vendor] EvoFlow tsconfig 开 strict（ZCode base 无 strictFunctionTypes），
            // (e: InputEvent) => void 不能直接赋给 addEventListener 的 (e: Event) => void。
            textarea.addEventListener("input", handleInput as EventListener, true);
            registryDisposers.push({
              dispose: () => textarea.removeEventListener("input", handleInput as EventListener, true),
            } as IDisposable);
          }
        })
        .catch((error) => {
          if (ptyCancelled) return;
          const message = error instanceof Error ? error.message : String(error);
          logger.error("[Terminal] persistent create failed:", error);
          term.write(`\r\n[Terminal failed to start]\r\n${message}\r\n`);
          // PTY 创建失败必须释放 registry 中本次占位的 entry。
          // entry 在上方以 terminalId="" 占位先 register（line 541），再异步 terminalService.create()。
          // 若失败不释放，terminalId="" 的僵尸 entry 会留在 registry，重挂/切 workspace 时命中
          // 复用快路径（见上方 existingEntry 分支），直接复用已启动失败的 xterm，且永不重新
          // terminalService.create()，该终端永久无法连接 PTY。
          //
          // ownership 校验（稳妥方案）：只有 registry 当前 entry 仍是本次创建的 entry 时才释放。
          // 极端时序：create reject 触发前，组件可能已卸载（cleanup 已 release 半成品，见下方 !entry.terminalId
          // 分支）并重挂、registry 已被新一次创建的 entry 覆盖。此时无脑 release 会误删新 entry。
          // 闭包 entry 引用比较 registry 当前值：每次创建都是新 entry 对象，引用比较天然区分代际。
          const currentEntry = sidePaneTerminalSessionRegistry.get(persistentKey);
          if (currentEntry === entry) {
            sidePaneTerminalSessionRegistry.release(persistentKey);
          }
        });

      // 组件局部：resize observer
      let resizeRAF = 0;
      const resizeObserver = new ResizeObserver(() => {
        if (!isVisibleRef.current) return;
        if (resizeRAF) cancelAnimationFrame(resizeRAF);
        resizeRAF = requestAnimationFrame(() => scheduleFitAndResize("observer"));
      });
      resizeObserver.observe(el);

      logger.debug("[Terminal] persistent create", {
        terminalTabId: sessionId,
        persistentKey,
      });

      return () => {
        ptyCancelled = true;
        themeObserver.disconnect();
        resizeObserver.disconnect();
        if (resizeRAF) cancelAnimationFrame(resizeRAF);
        for (const d of localDisposers) {
          try {
            d.dispose();
          } catch (error) {
            logger.warn("[Terminal] persistent cleanup local disposer failed:", error);
          }
        }
        // PTY 未就绪即被卸载（极少见）：回收半成品 entry，避免重挂复用到空 PTY
        if (!entry.terminalId) {
          sidePaneTerminalSessionRegistry.release(persistentKey);
        } else {
          sidePaneTerminalSessionRegistry.detachDom(persistentKey);
        }
        termRef.current = null;
        fitAddonRef.current = null;
      };
    }
    // ===== persistentKey 路径结束 =====

    let disposed = false;
    terminalProfileThemeRef.current = undefined;

    const term = new XTerm({
      fontSize: 13,
      fontFamily: DEFAULT_TERMINAL_FONT_FAMILY,
      theme: mergeTerminalTheme(terminalProfileThemeRef.current),
      linkHandler: {
        allowNonHttpProtocols: false,
        activate(event, text) {
          if (!isHttpTerminalUrl(text)) {
            return;
          }
          event.preventDefault();
          logger.debug("[Terminal] open OSC 8 http link", { url: text });
          openBrowserUrlRef.current(text);
        },
      } satisfies ILinkHandler,
    });
    termRef.current = term;

    const fitAddon = new FitAddon();
    fitAddonRef.current = fitAddon;
    term.loadAddon(fitAddon);
    // 接入 ClipboardAddon 以支持 OSC 52，并让 xterm 的 copy 事件把选区写入系统剪贴板。
    term.loadAddon(new ClipboardAddon());
    term.open(el);
    let initialTerminalSize: TerminalSize | null = null;
    if (isVisibleRef.current && el.clientWidth > 0 && el.clientHeight > 0) {
      try {
        // side pane 终端挂载时如果先用 xterm 默认列数创建 PTY，
        // 启动输出会在随后 fit/resize 时按错误宽度重排，zsh 可能显示反白的 PROMPT_EOL_MARK。
        // 首次可见时先同步 fit，再用真实 cols/rows 启动 PTY，避免启动输出和尺寸校正竞态。
        resizeRequestStatsRef.current.fit += 1;
        fitAddon.fit();
        initialTerminalSize = { cols: term.cols, rows: term.rows };
        lastSentTerminalSizeRef.current = initialTerminalSize;
        logger.debug("[Terminal] initial fit before create", {
          cols: initialTerminalSize.cols,
          rows: initialTerminalSize.rows,
          terminalTabId: sessionId,
        });
      } catch (error) {
        logger.warn("[Terminal] initial fit failed:", error);
      }
    }
    if (isVisibleRef.current) {
      requestFocus();
    }

    // 拦截 Ctrl/Cmd+C、Ctrl/Cmd+V：
    // - Ctrl+C 在 Win/Linux 默认会被当作 SIGINT 传给 PTY，必须在有选区时改走复制；
    // - Ctrl+V 不拦截会被当作 `^V` 字符输入。
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      inputFallbackKeydownCandidateRef.current =
        e.metaKey || e.ctrlKey || e.altKey
          ? null
          : createTerminalInputFallbackKeydownCandidate({
              eventTimeStamp: e.timeStamp,
              key: e.key,
              now: performance.now(),
            });
      if (!(e.metaKey || e.ctrlKey)) return true;
      const key = e.key.toLowerCase();
      if (key === "c" && term.hasSelection()) {
        void navigator.clipboard.writeText(term.getSelection()).catch((err) => {
          logger.warn("[Terminal] copy via shortcut failed:", err);
        });
        return false;
      }
      if (key === "v") {
        // attachCustomKeyEventHandler 返回 false 只阻止 xterm 处理 Ctrl+V，
        // 不会取消浏览器随后派发的原生 paste 事件；这里手动 paste 一次后，
        // 原生 paste 又会被 xterm 的内置监听写入一次，导致快捷键粘贴重复。
        // 因此必须先取消默认事件，再保留手动读取剪贴板的单次写入。
        e.preventDefault();
        e.stopPropagation();
        navigator.clipboard
          .readText()
          .then((text) => {
            logger.debug("[Terminal] paste via shortcut", { length: text.length });
            if (text) term.paste(text);
          })
          .catch((err) => logger.warn("[Terminal] paste via shortcut failed:", err));
        return false;
      }
      return true;
    });

    // 监听主题切换，实时更新 terminal 配色
    const observer = new MutationObserver(() => {
      term.options.theme = mergeTerminalTheme(terminalProfileThemeRef.current);
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });

    const disposables: IDisposable[] = [];
    const { terminalService } = services;
    disposables.push(
      // 交互说明：plain URL 不属于 React DOM，必须通过 xterm link provider 从 buffer
      // 计算可点击区域，再统一交给右侧 browser pane，避免在终端层直接碰平台 API。
      term.registerLinkProvider({
        provideLinks(bufferLineNumber, callback) {
          const links = getHttpLinksForTerminalBufferLine(
            term.buffer.active,
            bufferLineNumber,
            term.cols,
          )?.map(
            (link): ILink => ({
              ...link,
              activate(event, text) {
                event.preventDefault();
                logger.debug("[Terminal] open plain http link", { url: text });
                openBrowserUrlRef.current(text);
              },
            }),
          );

          callback(links);
        },
      }),
    );

    // 优先使用 workspace 路径作为 terminal 工作目录，未设置时后端回退到 HOME
    const initialCreateSize = initialTerminalSize ?? { cols: term.cols, rows: term.rows };
    terminalService
      .create({ cols: initialCreateSize.cols, rows: initialCreateSize.rows, cwd })
      .then(({ id, shell, fontFamily, fontSize, theme, fontFamilySource, windowsPty }) => {
        if (disposed) {
          terminalService.dispose({ id });
          return;
        }

        terminalIdRef.current = id;
        // 首次 fit 或 ResizeObserver 可能早于 terminal id ready，先把 resize
        // 暂存在 pendingTerminalSizeRef；id ready 后必须主动 flush，否则相同尺寸会被去重逻辑跳过。
        flushTerminalServiceResize();
        // Windows ConPTY 在 resize 增高时不会像传统 Unix PTY 一样把 scrollback 拉回 viewport，
        // 不开启 xterm 的 windowsPty 兼容会让 PSReadLine 后续按旧坐标重绘输入，覆盖到上一条命令输出行。
        term.options.windowsPty = normalizeWindowsPtyOption(windowsPty);
        term.options.fontFamily = fontFamily || DEFAULT_TERMINAL_FONT_FAMILY;
        const nextFontSize = normalizeTerminalFontSize(fontSize);
        if (nextFontSize) {
          term.options.fontSize = nextFontSize;
        }
        terminalProfileThemeRef.current = theme as ITheme | undefined;
        term.options.theme = mergeTerminalTheme(terminalProfileThemeRef.current);
        const nextShellLabel = formatShellLabel(shell);
        logger.info("[Terminal] shell resolved:", {
          cwd,
          fontFamilySource,
          shell,
          shellLabel: nextShellLabel,
          terminalId: id,
          terminalTabId: sessionId,
        });
        onShellLabelChange(sessionId, nextShellLabel);
        scheduleFitAndResize("init");
        if (isVisibleRef.current) {
          requestFocus();
        }

        disposables.push(
          terminalService.onDynamicData(id)((data) => {
            term.write(normalizePowerShellReadlineRedraw(data, shell));
          }),
        );

        disposables.push(
          terminalService.onDynamicExit(id)((exitCode) => {
            const exitHandler = exitHandlerRef.current;
            logger.info("[Terminal] terminal session exited", {
              autoClose: Boolean(exitHandler),
              exitCode,
              terminalId: id,
              terminalTabId: sessionId,
            });
            if (exitHandler) {
              exitHandler(sessionId, exitCode);
              return;
            }

            // side pane Terminal 不属于底部 tab registry，未传 onExit 时继续保留退出提示。
            term.write(`\r\n${exitedMessageRef.current}\r\n`);
          }),
        );

        disposables.push(
          term.onData((data) => {
            const now = performance.now();
            const inputFallbackKeydownCandidate = inputFallbackKeydownCandidateRef.current;
            const handledData = recordTerminalInputFallbackHandledData({
              candidate: inputFallbackKeydownCandidate,
              data,
              history: recentInputFallbackHandledDataRef.current,
              maxAgeMs: TERMINAL_INPUT_FALLBACK_RECENT_DATA_MS,
              now,
            });
            recentInputFallbackHandledDataRef.current = handledData.usedCandidate
              ? handledData.history
              : recordTerminalInputFallbackRecentData({
                  data,
                  history: handledData.history,
                  maxAgeMs: TERMINAL_INPUT_FALLBACK_RECENT_DATA_MS,
                  now,
                });
            if (handledData.usedCandidate) {
              inputFallbackKeydownCandidateRef.current = null;
            }
            markTerminalInputFallbackHandled(pendingInputFallbacksRef.current, data);
            terminalService.write({ id, data });
          }),
        );

        // Windows desktop 下某些输入法会把 composed text 留在 textarea 里，
        // xterm 可能只处理到一半；这里保留兜底。但 Linux Wayland 已确认会和 xterm 的
        // onData 路径重复写入，所以必须显式收窄到 Windows，避免把正常链路误伤。
        const textarea =
          isWindowsDesktop &&
          (term as unknown as { _core: { textarea: HTMLTextAreaElement } })._core?.textarea;
        if (textarea) {
          const handleInput = (e: InputEvent) => {
            // 只处理组合文本的 insertText
            if (e.inputType !== "insertText" || !e.data || !e.composed) return;
            const insertedText = e.data;
            const now = performance.now();
            const pendingFallback = createPendingTerminalInputFallback(insertedText);
            pendingInputFallbacksRef.current.push(pendingFallback);
            // 普通空格会先经 keydown 被 xterm onData 写入 PTY，随后浏览器才派发 composed input。
            // 搜狗输入法也会在没有稳定 keydown candidate 的情况下先触发 xterm onData、后触发 composed input。
            // 这里消费同一次输入附近的未消费 onData，避免把同一段组合文本再兜底写入一次。
            consumeTerminalInputFallbackHandledData({
              history: recentInputFallbackHandledDataRef.current,
              inputEventTimeStamp: e.timeStamp,
              maxAgeMs: TERMINAL_INPUT_FALLBACK_RECENT_DATA_MS,
              maxInputDelayMs: TERMINAL_INPUT_FALLBACK_KEYDOWN_INPUT_MS,
              now,
              pending: pendingFallback,
            });

            // 延迟检查：等 xterm 的 onData 先认领 pending，再判断是否需要兜底写入。
            setTimeout(() => {
              pendingInputFallbacksRef.current = pendingInputFallbacksRef.current.filter(
                (item) => item !== pendingFallback,
              );
              if (disposed) {
                return;
              }
              const fallbackAction = resolveTerminalInputFallbackAction({
                pending: pendingFallback,
                textareaValue: textarea.value,
              });
              if (fallbackAction.shouldWrite) {
                // 普通空格也会触发 composed input，且 xterm 已经通过 onData 写入 PTY。
                // 只看 textarea.value 会把空格再手动写一次；这里必须确认 onData 没处理过才兜底。
                logger.debug("[Terminal] flush composed input fallback", {
                  length: insertedText.length,
                  terminalId: id,
                  terminalTabId: sessionId,
                });
                terminalService.write({ id, data: insertedText });
              }
              if (fallbackAction.shouldClearTextarea) {
                textarea.value = "";
              }
            }, TERMINAL_INPUT_FALLBACK_FLUSH_DELAY_MS);
          };

          // [evoflow-vendor] 同上：strict 下 InputEvent handler 需收窄为 EventListener。
          textarea.addEventListener("input", handleInput as EventListener, true);
          disposables.push({
            dispose: () => textarea.removeEventListener("input", handleInput as EventListener, true),
          } as IDisposable);
        }
      })
      .catch((error) => {
        // 之前没有接住 create() 的拒绝态，终端启动失败会直接变成 Uncaught Promise。
        // 这里显式记录错误，并在终端区域提示用户，方便定位到底是 shell 还是 cwd 出了问题。
        if (disposed) return;
        const message = error instanceof Error ? error.message : String(error);
        logger.error("[Terminal] failed to create terminal:", error);
        term.write(`\r\n[Terminal failed to start]\r\n${message}\r\n`);
      });

    let resizeRAF = 0;
    const resizeObserver = new ResizeObserver(() => {
      if (!isVisibleRef.current) return;
      if (resizeRAF) cancelAnimationFrame(resizeRAF);
      resizeRAF = requestAnimationFrame(() => scheduleFitAndResize("observer"));
    });
    resizeObserver.observe(el);

    return () => {
      disposed = true;
      observer.disconnect();
      resizeObserver.disconnect();
      clearResizeThrottleTimer();
      if (resizeRAF) cancelAnimationFrame(resizeRAF);
      if (resizeRAFRef.current) cancelAnimationFrame(resizeRAFRef.current);
      if (focusRAFRef.current) cancelAnimationFrame(focusRAFRef.current);
      pendingInputFallbacksRef.current = [];
      inputFallbackKeydownCandidateRef.current = null;
      recentInputFallbackHandledDataRef.current = [];
      pendingTerminalSizeRef.current = null;
      lastSentTerminalSizeRef.current = null;
      resizeInFlightRef.current = false;
      for (const d of disposables) d.dispose();
      if (terminalIdRef.current) {
        terminalService.dispose({ id: terminalIdRef.current });
      }
      terminalIdRef.current = undefined;
      fitAddonRef.current = null;
      term.dispose();
      termRef.current = null;
    };
  }, [
    clearResizeThrottleTimer,
    cwd,
    isWindowsDesktop,
    onShellLabelChange,
    requestFocus,
    scheduleFitAndResize,
    flushTerminalServiceResize,
    services,
    sessionId,
    persistentKey,
  ]);

  const handleCopy = () => {
    const term = termRef.current;
    if (!term?.hasSelection()) return;
    void navigator.clipboard.writeText(term.getSelection()).catch((err) => {
      logger.warn("[Terminal] copy via context menu failed:", err);
    });
  };

  const handlePaste = () => {
    const term = termRef.current;
    if (!term) return;
    navigator.clipboard
      .readText()
      .then((text) => text && term.paste(text))
      .catch((err) => logger.warn("[Terminal] paste via context menu failed:", err));
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={containerRef}
          className="terminal-xterm-shell h-full min-h-0 w-full overflow-hidden"
        />
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={handleCopy}>
          <Copy className="mr-2 h-4 w-4" />
          {intl.formatMessage({ id: "terminal.contextMenu.copy" })}
        </ContextMenuItem>
        <ContextMenuItem onSelect={handlePaste}>
          <ClipboardPaste className="mr-2 h-4 w-4" />
          {intl.formatMessage({ id: "terminal.contextMenu.paste" })}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
