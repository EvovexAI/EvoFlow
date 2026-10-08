// ============================================================
// 脚本 transcript 条目的展开面板
// ============================================================
// 挂载即取正文（条目只在展开时挂它），取回即缓存。三种正文：Terminal（`$ 命令行`、stdout、
// 单独成段、淡红底的 stderr、页脚 exit · 耗时 · 字节 + Copy）、清单（glob / grep /
// changed-files，带行号、按行有界）、文本（read / diff，diff 按首字符着墨）。

import { memo, useCallback, useState, type ReactNode } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useWorkflowRunNodeResult } from "@/hooks/useWorkflowRunNodeResult.js";
import {
  formatWorkspaceBytes,
  formatWorkspaceDuration,
  type WorkspaceCardModel,
} from "@/app-shell/workflowWorkspaceTranscript.js";

/** 正文最多画多少行：网关按 32 KB 有界，这里再按行有界——一屏读不完的东西留在 journal 里。 */
const WORKSPACE_RESULT_MAX_LINES = 200;

const PRE_CLASS =
  "m-0 max-h-[300px] overflow-auto whitespace-pre-wrap break-words px-3 py-2.5 font-mono text-ui-sm leading-[17px] text-foreground-subtle";
const NOTE_CLASS = "px-3 py-2.5 font-mono text-ui-sm text-foreground-subtle";

function boundLines(text: string): { text: string; shown: number; total: number } {
  const lines = text.split("\n");
  if (lines.length <= WORKSPACE_RESULT_MAX_LINES) {
    return { text, shown: lines.length, total: lines.length };
  }
  return {
    text: lines.slice(0, WORKSPACE_RESULT_MAX_LINES).join("\n"),
    shown: WORKSPACE_RESULT_MAX_LINES,
    total: lines.length,
  };
}

function isRunResult(
  value: unknown,
): value is { exitCode: number; stdout: string; stderr: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const fields = value as Record<string, unknown>;
  return typeof fields.exitCode === "number" && typeof fields.stdout === "string";
}

function isGrepMatch(value: unknown): value is { path: string; line: number; text: string } {
  if (value === null || typeof value !== "object") return false;
  const fields = value as Record<string, unknown>;
  return typeof fields.path === "string" && typeof fields.line === "number";
}

/** `+` / `-` / `@@` 三种墨：diff 的每一行按首字符着色，其余原样。 */
function DiffLines({ text }: { text: string }) {
  return (
    <pre className={PRE_CLASS}>
      {text.split("\n").map((line, index) => (
        <span
          className={cn(
            "block",
            line.startsWith("+") && !line.startsWith("+++") && "text-success",
            line.startsWith("-") && !line.startsWith("---") && "text-destructive",
            (line.startsWith("@@") || line.startsWith("diff ")) && "text-foreground-subtlest",
          )}
          key={index}
        >
          {line}
        </span>
      ))}
    </pre>
  );
}

function CopyButton({ text }: { text: string }) {
  const { intl } = useZCodeIntl();
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    if (text.length === 0) return;
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  }, [text]);
  return (
    <button
      className="inline-flex h-[22px] items-center gap-1.5 rounded-[5px] px-1.5 font-sans text-foreground-subtle transition-colors hover:bg-surface-hover hover:text-foreground"
      data-testid="workflow-workspace-copy"
      onClick={copy}
      type="button"
    >
      {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
      {intl.formatMessage({
        id: copied ? "chat.toolCall.copyError.copied" : "chat.toolCall.copyError",
      })}
    </button>
  );
}

/** 页脚：`exit 1 · 1.94 s · 1.3 KB` + 右侧 Copy；截断说明另起一行，不挤页脚的数字。 */
function Footer({ parts, note, copy }: { parts: ReactNode[]; note?: string; copy: string }) {
  return (
    <div
      className="border-t border-border px-3 py-1.5 font-mono text-ui-xs tabular-nums text-foreground-subtlest"
      data-testid="workflow-workspace-card-footer"
    >
      <div className="flex items-center gap-2">
        {parts.map((part, index) => (
          <span className="flex items-center gap-2 whitespace-nowrap" key={index}>
            {index > 0 ? <span aria-hidden>·</span> : null}
            <span>{part}</span>
          </span>
        ))}
        <span className="flex-1" />
        <CopyButton text={copy} />
      </div>
      {note === undefined ? null : <p className="mt-1 font-sans leading-snug">{note}</p>}
    </div>
  );
}

export const WorkspaceCardBody = memo(function WorkspaceCardBody({
  card,
  runId,
  sessionId,
}: {
  card: WorkspaceCardModel;
  runId: string;
  sessionId: string;
}) {
  const { intl } = useZCodeIntl();
  const format = intl.formatMessage.bind(intl);
  const { node } = card;
  const { result, loading, error } = useWorkflowRunNodeResult({
    sessionId,
    runId,
    siteId: node.siteId,
    ordinal: node.ordinal,
    enabled: node.status === "completed",
  });
  const durationMs = Math.max(0, node.updatedAt - node.createdAt);
  const truncatedNote = (shown: string, total: string) =>
    format({ id: "chat.toolCall.workflow.script.result.truncated" }, { shown, total });
  const linesOf = (count: number) =>
    format({ id: "chat.toolCall.workflow.script.result.lines" }, { count: String(count) });

  let body: ReactNode = null;
  let footer: ReactNode = null;
  if (loading) {
    body = (
      <p className={cn(NOTE_CLASS, "animated-gradient-text-subtle")}>
        {format({ id: "chat.toolCall.workflow.script.result.loading" })}
      </p>
    );
  } else if (error !== null) {
    body = (
      <p className={cn(NOTE_CLASS, "text-destructive")}>
        {format({ id: "chat.toolCall.workflow.script.result.loadFailed" }, { error })}
      </p>
    );
  } else if (node.status === "failed") {
    body = (
      <pre className={cn(PRE_CLASS, "text-destructive")}>
        {node.error?.message ?? node.error?.code ?? ""}
      </pre>
    );
  } else if (node.status === "running") {
    body = (
      <p className={cn(NOTE_CLASS, "animated-gradient-text-subtle")}>
        {format({ id: "chat.toolCall.execute.running" })}…
      </p>
    );
  } else if (result?.result !== undefined) {
    const value = result.result;
    if (isRunResult(value)) {
      const stdout = boundLines(value.stdout);
      const stderr = boundLines(value.stderr ?? "");
      body = (
        <>
          {stdout.text.length > 0 ? (
            <pre className={PRE_CLASS}>{stdout.text}</pre>
          ) : stderr.text.length === 0 ? (
            <p className={NOTE_CLASS}>{format({ id: "chat.toolCall.execute.noOutput" })}</p>
          ) : null}
          {stderr.text.length > 0 ? (
            <div
              className="border-t border-border bg-[color-mix(in_oklab,var(--color-destructive)_3%,transparent)]"
              data-testid="workflow-workspace-stderr"
            >
              <div className="px-3 pt-2 text-ui-xs uppercase tracking-[0.08em] text-destructive/80">
                {format({ id: "chat.toolCall.workflow.script.result.stderr" })}
              </div>
              <pre className={cn(PRE_CLASS, "pt-1 text-foreground")}>{stderr.text}</pre>
            </div>
          ) : null}
        </>
      );
      const parts: ReactNode[] = [
        <span
          className={cn(
            "font-semibold",
            value.exitCode === 0 ? "text-success" : "text-destructive",
          )}
          key="exit"
        >
          {format(
            { id: "chat.toolCall.workflow.script.status.exit" },
            { code: String(value.exitCode) },
          )}
        </span>,
        formatWorkspaceDuration(durationMs),
        formatWorkspaceBytes(node.summary?.stdoutBytes ?? result.totalBytes),
      ];
      const note =
        stdout.total > stdout.shown || result.truncated
          ? truncatedNote(linesOf(stdout.shown), formatWorkspaceBytes(result.totalBytes))
          : undefined;
      footer = <Footer parts={parts} note={note} copy={value.stdout} />;
    } else if (Array.isArray(value)) {
      const items = value.slice(0, WORKSPACE_RESULT_MAX_LINES);
      const grep = card.op === "grep";
      body =
        value.length === 0 ? (
          <p className={NOTE_CLASS}>
            {format({ id: "chat.toolCall.workflow.script.result.empty" })}
          </p>
        ) : (
          <ul className="max-h-[300px] overflow-auto py-1.5 font-mono text-ui-sm leading-[18px] text-foreground">
            {items.map((item, index) => (
              <li
                className="flex gap-2.5 px-3 py-px"
                key={index}
                title={isGrepMatch(item) ? item.text : undefined}
              >
                <span className="w-[22px] shrink-0 text-right text-foreground-subtlest">
                  {isGrepMatch(item) ? item.line : index + 1}
                </span>
                {isGrepMatch(item) ? (
                  <span className="min-w-0 truncate">
                    <span>{item.path}</span>
                    <span className="ml-2 text-foreground-subtle">{item.text.trim()}</span>
                  </span>
                ) : (
                  <span className="min-w-0 truncate">{String(item)}</span>
                )}
              </li>
            ))}
            {value.length > items.length ? (
              <li className="px-3 pl-[46px] pt-1 text-ui-xs text-foreground-subtlest">
                {format(
                  { id: "chat.toolCall.workflow.script.result.more" },
                  { count: String(value.length - items.length) },
                )}
              </li>
            ) : null}
          </ul>
        );
      const total = node.summary?.resultCount ?? value.length;
      const parts: ReactNode[] = [
        format(
          {
            id: grep
              ? "chat.toolCall.workflow.script.result.matches"
              : "chat.toolCall.workflow.script.result.files",
          },
          { count: String(total) },
        ),
        formatWorkspaceDuration(durationMs),
      ];
      const note =
        items.length < total || result.truncated
          ? truncatedNote(String(items.length), String(total))
          : undefined;
      const copy = items
        .map((item) =>
          isGrepMatch(item) ? `${item.path}:${item.line} ${item.text}` : String(item),
        )
        .join("\n");
      footer = <Footer parts={parts} note={note} copy={copy} />;
    } else if (typeof value === "string") {
      const bounded = boundLines(value);
      body =
        value.length === 0 ? (
          <p className={NOTE_CLASS}>{format({ id: "chat.toolCall.execute.noOutput" })}</p>
        ) : card.op === "git-diff" ? (
          <DiffLines text={bounded.text} />
        ) : (
          <pre className={PRE_CLASS}>{bounded.text}</pre>
        );
      const parts: ReactNode[] = [
        formatWorkspaceDuration(durationMs),
        formatWorkspaceBytes(result.totalBytes),
      ];
      const note =
        bounded.total > bounded.shown || result.truncated
          ? truncatedNote(linesOf(bounded.shown), formatWorkspaceBytes(result.totalBytes))
          : undefined;
      footer = <Footer parts={parts} note={note} copy={bounded.text} />;
    } else {
      const text = JSON.stringify(value, null, 2);
      body = <pre className={PRE_CLASS}>{text}</pre>;
      footer = (
        <Footer
          parts={[formatWorkspaceDuration(durationMs), formatWorkspaceBytes(result.totalBytes)]}
          copy={text}
        />
      );
    }
  }

  return (
    <div
      className="wf-ws-body mt-1.5 overflow-hidden rounded-[10px] border border-border bg-card"
      data-testid="workflow-workspace-card-body"
      data-ws-body
    >
      {card.command === undefined ? null : (
        <div className="flex gap-2 border-b border-border px-3 py-2.5 font-mono text-[12.5px] text-foreground">
          <span className="shrink-0 text-foreground-subtlest">$</span>
          <pre className="m-0 min-w-0 flex-1 whitespace-pre-wrap break-words font-mono">
            {card.command}
          </pre>
        </div>
      )}
      {body}
      {footer}
    </div>
  );
});
