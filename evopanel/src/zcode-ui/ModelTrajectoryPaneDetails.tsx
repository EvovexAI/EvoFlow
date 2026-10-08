import type { ReactNode } from "react";
import type { ZCodeModelTrajectoryContentPart, ZCodeModelTrajectoryRecord } from "@zcode/services";
import { Badge } from "@/components/ui/badge.js";
import { cn } from "@/components/lib/utils.js";
import type { useZCodeIntl } from "@/i18n/IntlProvider.js";

type IntlShape = ReturnType<typeof useZCodeIntl>["intl"];

export function ContentPartView({
  part,
  intl,
  sectionLabel,
  showToolHeader = true,
}: {
  part: ZCodeModelTrajectoryContentPart;
  intl: IntlShape;
  sectionLabel?: string;
  showToolHeader?: boolean;
}) {
  if (part.kind === "text") {
    if (!part.text) {
      return null;
    }
    const content = (
      <p className="whitespace-pre-wrap break-words text-ui-sm leading-relaxed text-foreground">
        {part.text}
      </p>
    );
    return sectionLabel ? <DetailSection label={sectionLabel}>{content}</DetailSection> : content;
  }

  if (part.kind === "reasoning") {
    if (!part.text) {
      return null;
    }
    return (
      <DetailSection label={intl.formatMessage({ id: "modelTrajectory.reasoning" })}>
        <p className="whitespace-pre-wrap break-words font-mono text-ui-sm leading-relaxed text-foreground-subtle">
          {part.text}
        </p>
      </DetailSection>
    );
  }

  if (part.kind === "tool-call") {
    return (
      <ToolPayload
        id={part.toolCallId}
        label={`${intl.formatMessage({ id: "modelTrajectory.toolCall" })} · ${part.toolName}`}
        payloadLabel={intl.formatMessage({ id: "modelTrajectory.toolInput" })}
        value={part.input}
        intl={intl}
        showHeader={showToolHeader}
      />
    );
  }

  if (part.kind === "tool-result") {
    return (
      <ToolPayload
        id={part.toolCallId}
        label={
          part.toolName
            ? `${intl.formatMessage({ id: "modelTrajectory.toolResult" })} · ${part.toolName}`
            : intl.formatMessage({ id: "modelTrajectory.toolResult" })
        }
        payloadLabel={intl.formatMessage({ id: "modelTrajectory.toolOutput" })}
        value={part.output}
        intl={intl}
        showHeader={showToolHeader}
      />
    );
  }

  if (part.kind === "image") {
    return (
      <span className="text-ui-sm italic text-foreground-subtle">
        [image{part.mediaType ? ` · ${part.mediaType}` : ""}]
      </span>
    );
  }

  return <CodeBlock value={formatValue(part.raw)} />;
}

function ToolPayload({
  label,
  id,
  payloadLabel,
  value,
  intl,
  showHeader,
}: {
  label: string;
  id?: string;
  payloadLabel: string;
  value: unknown;
  intl: IntlShape;
  showHeader: boolean;
}) {
  const payload = (
    <div className="flex flex-col gap-1.5 rounded-md border border-border bg-card px-2.5 py-2">
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <span className="text-ui-sm font-medium text-foreground-subtle">{payloadLabel}</span>
      </div>
      <CodeBlock value={formatValue(value)} />
    </div>
  );

  return showHeader ? (
    <DetailSection label={label} meta={id ? <ToolIdBadge id={id} intl={intl} /> : null}>
      {payload}
    </DetailSection>
  ) : (
    payload
  );
}

function ToolIdBadge({ id, intl }: { id: string; intl: IntlShape }) {
  return (
    <Badge
      variant="outline"
      className="max-w-full truncate font-mono text-foreground-subtle"
      title={id}
    >
      {intl.formatMessage({ id: "modelTrajectory.toolId" })}: {id}
    </Badge>
  );
}

function DetailSection({
  label,
  meta,
  children,
}: {
  label: string;
  meta?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 items-center gap-1 px-1.5 py-1 text-ui-sm font-medium text-foreground-subtle">
        <span className="min-w-0 flex-1 break-words font-mono">{label}</span>
        {meta ? <span className="min-w-0 shrink">{meta}</span> : null}
      </div>
      {children}
    </section>
  );
}

function CodeBlock({ value }: { value: string }) {
  return (
    <pre className="max-h-64 min-w-0 overflow-auto whitespace-pre rounded-md bg-surface px-2 py-1.5 font-mono text-ui-sm leading-relaxed text-foreground">
      {value || "—"}
    </pre>
  );
}

export function EmptyState({
  text,
  detail,
  tone,
}: {
  text: string;
  detail?: string;
  tone?: "error";
}) {
  return (
    <div className="flex flex-col items-center gap-1 px-4 py-10 text-center">
      <p
        className={cn(
          "text-ui-base",
          tone === "error" ? "text-destructive" : "text-foreground-subtle",
        )}
      >
        {text}
      </p>
      {detail ? (
        <p className="max-w-full break-words font-mono text-ui-base text-foreground-subtlest">
          {detail}
        </p>
      ) : null}
    </div>
  );
}

export function summarizeRecords(records: ZCodeModelTrajectoryRecord[]): {
  totalTokens: number;
  models: string[];
} {
  let totalTokens = 0;
  const models = new Set<string>();
  for (const record of records) {
    const total = record.response?.usage?.totalTokens;
    if (typeof total === "number") {
      totalTokens += total;
    }
    const model = record.model.modelId ?? record.response?.modelId;
    if (model) {
      models.add(model);
    }
  }
  return { totalTokens, models: [...models] };
}

function formatValue(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
