/**
 * 长会话友好提示：消息很多 / 上下文偏满时，提醒可主动压缩。
 * 挂在对话区顶部（主聊 V4），点击走既有手动压缩。
 * 出现后只亮几秒再自动收起，避免一直顶着难受；水位再涨约百条可再提醒。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FoldVerticalIcon, InfoIcon, XIcon } from "lucide-react";

/** 「几百」起步：约 200 条消息后提示；上下文占用也作辅助触发。 */
export const COMPACT_TIP_MESSAGE_COUNT = 200;
export const COMPACT_TIP_PCT = 75;
/** 提示条自动收起（毫秒）：亮几秒就藏，别一直顶着。 */
export const COMPACT_TIP_AUTO_DISMISS_MS = 5_500;

function dismissStorageKey(sessionKey: string): string {
  return `evoflow:compact-tip-dismissed:${sessionKey}`;
}

function readDismissedAtCount(sessionKey: string): number | null {
  try {
    const raw = sessionStorage.getItem(dismissStorageKey(sessionKey));
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

function writeDismissedAtCount(sessionKey: string, messageCount: number): void {
  try {
    sessionStorage.setItem(dismissStorageKey(sessionKey), String(Math.max(0, Math.round(messageCount))));
  } catch {
    /* ignore quota / private mode */
  }
}

function clearDismissed(sessionKey: string): void {
  try {
    sessionStorage.removeItem(dismissStorageKey(sessionKey));
  } catch {
    /* ignore */
  }
}

export function shouldShowCompactTip(params: {
  messageCount?: number | null;
  pct?: number | null;
  dismissedAtCount?: number | null;
}): boolean {
  const count =
    params.messageCount != null && Number.isFinite(Number(params.messageCount))
      ? Math.max(0, Math.round(Number(params.messageCount)))
      : 0;
  const pct =
    params.pct != null && Number.isFinite(Number(params.pct))
      ? Number(params.pct)
      : 0;
  const byCount = count >= COMPACT_TIP_MESSAGE_COUNT;
  const byPct = pct >= COMPACT_TIP_PCT && count >= 80;
  if (!byCount && !byPct) return false;
  const dismissedAt = params.dismissedAtCount;
  if (dismissedAt != null && Number.isFinite(dismissedAt)) {
    // 关掉后若又涨了约一轮「百条」，再提醒一次
    if (count < dismissedAt + 100) return false;
  }
  return true;
}

export function ConversationCompactTipBanner({
  sessionKey,
  messageCount,
  pct,
  compacting = false,
  sessionBusy = false,
  onCompact,
}: {
  sessionKey?: string | null;
  messageCount?: number | null;
  pct?: number | null;
  compacting?: boolean;
  sessionBusy?: boolean;
  onCompact?: () => void | Promise<void>;
}): React.JSX.Element | null {
  const sk = String(sessionKey || "").trim();
  const count =
    messageCount != null && Number.isFinite(Number(messageCount))
      ? Math.max(0, Math.round(Number(messageCount)))
      : 0;
  const [dismissedAtCount, setDismissedAtCount] = useState<number | null>(() =>
    sk ? readDismissedAtCount(sk) : null,
  );

  useEffect(() => {
    setDismissedAtCount(sk ? readDismissedAtCount(sk) : null);
  }, [sk]);

  // 压缩成功后上下文变短：清掉 dismiss，避免旧水位挡住下次提醒
  useEffect(() => {
    if (!sk || count <= 0) return;
    const dismissed = readDismissedAtCount(sk);
    if (dismissed != null && count + 40 < dismissed) {
      clearDismissed(sk);
      setDismissedAtCount(null);
    }
  }, [sk, count]);

  const visible = useMemo(
    () =>
      shouldShowCompactTip({
        messageCount: count,
        pct,
        dismissedAtCount,
      }),
    [count, pct, dismissedAtCount],
  );

  const onDismiss = useCallback(() => {
    if (!sk) {
      setDismissedAtCount(count);
      return;
    }
    writeDismissedAtCount(sk, count);
    setDismissedAtCount(count);
  }, [sk, count]);

  // 出现后只计时一次就收；勿把 onDismiss/count 放进 deps，否则流式涨条数会不断重设定时器、提示永远不关。
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;
  useEffect(() => {
    if (!visible || !onCompact) return;
    const t = window.setTimeout(() => {
      onDismissRef.current();
    }, COMPACT_TIP_AUTO_DISMISS_MS);
    return () => window.clearTimeout(t);
  }, [visible, onCompact, sk]);

  const onClickCompact = useCallback(() => {
    if (!onCompact || compacting || sessionBusy) return;
    void onCompact();
  }, [onCompact, compacting, sessionBusy]);

  if (!visible || !onCompact) return null;

  const busy = Boolean(compacting || sessionBusy);
  const countLabel = count > 0 ? `约 ${count} 条消息` : "上下文偏满";

  return (
    <div
      className="mb-2 w-full shrink-0 px-4 max-md:px-2"
      data-testid="v4-conversation-compact-tip"
      role="status"
    >
      <div className="flex w-full flex-wrap items-center gap-2 rounded-xl border border-border/80 bg-card/90 px-3 py-2 text-ui-sm text-foreground shadow-sm">
        <div className="flex min-w-0 flex-1 items-start gap-2">
          <InfoIcon className="mt-0.5 size-4 shrink-0 text-foreground-subtle" aria-hidden />
          <div className="min-w-0 break-words leading-snug text-foreground-subtle">
            对话已经很长了（{countLabel}），继续聊可能变慢。如果暂时没有其他操作，可以
            <button
              type="button"
              className="mx-0.5 inline font-medium text-foreground underline decoration-foreground/30 underline-offset-2 hover:decoration-foreground disabled:cursor-not-allowed disabled:opacity-50 disabled:no-underline"
              disabled={busy}
              title={
                sessionBusy
                  ? "请等当前任务结束后再压缩"
                  : compacting
                    ? "正在压缩…"
                    : "压缩上下文，加快后续回复"
              }
              onClick={onClickCompact}
            >
              点这里主动压缩
            </button>
            ，让后面回复更快。
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            className="inline-flex h-7 items-center gap-1 rounded-full border border-border bg-surface px-2.5 text-ui-sm text-foreground hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50"
            disabled={busy}
            onClick={onClickCompact}
            data-testid="v4-conversation-compact-tip-action"
          >
            <FoldVerticalIcon className="size-3.5" aria-hidden />
            {compacting ? "压缩中…" : "压缩上下文"}
          </button>
          <button
            type="button"
            className="inline-flex size-7 items-center justify-center rounded-full text-foreground-subtlest hover:bg-hover hover:text-foreground"
            aria-label="关闭提示"
            title="关闭提示"
            onClick={onDismiss}
            data-testid="v4-conversation-compact-tip-dismiss"
          >
            <XIcon className="size-3.5" aria-hidden />
          </button>
        </div>
      </div>
    </div>
  );
}
