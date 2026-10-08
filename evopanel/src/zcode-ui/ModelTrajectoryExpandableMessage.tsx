import type { ZCodeModelTrajectoryMessage } from "@zcode/services";
import { ArrowRightIcon, ChevronRightIcon, CircleAlertIcon, CopyIcon } from "lucide-react";
import { useContext, useState } from "react";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible.js";
import type { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import {
  TrajectoryExpansionCommandContext,
  TrajectoryExpansionRegistryContext,
} from "@/ModelTrajectoryExpansion.js";
import { TrajectoryExpandedContent } from "@/ModelTrajectoryExpandedContent.js";
import { TrajectorySearchRevealContext } from "@/ModelTrajectorySearch.js";
import { trajectoryRoleTextClass, type TrajectoryVisualRole } from "@/ModelTrajectoryRoleStyles.js";
import {
  trajectoryToolHasError,
  trajectoryToolMetadata,
  trajectoryToolOutputs,
  trajectoryToolPayloadErrorText,
} from "@/ModelTrajectoryToolPayload.js";

type IntlShape = ReturnType<typeof useZCodeIntl>["intl"];

export function ExpandableTrajectoryMessage({
  message,
  role,
  visualRole,
  roleLabel,
  callDurationLabel,
  callDatetimeLabel,
  callDatetimeTitle,
  isAlt = false,
  intl,
  expansionKey,
}: {
  message: ZCodeModelTrajectoryMessage;
  role: "system" | "user" | "assistant" | "tool";
  visualRole?: TrajectoryVisualRole;
  roleLabel: string;
  callDurationLabel: string;
  callDatetimeLabel: string;
  callDatetimeTitle: string;
  isAlt?: boolean;
  intl: IntlShape;
  expansionKey?: string;
}) {
  const expansionCommands = useContext(TrajectoryExpansionCommandContext);
  const expansionRegistry = useContext(TrajectoryExpansionRegistryContext);
  const searchRevealKey = useContext(TrajectorySearchRevealContext);
  const [localExpansion, setLocalExpansion] = useState({ open: true, commandVersion: 0 });
  const copyLabel = intl.formatMessage({ id: "chat.message.copy" });
  const copyText = messageClipboardText(message);
  const toolResultMeta = trajectoryToolMetadata(message);
  const toolPayloadHasError = trajectoryToolHasError(message);
  const payloadDirection = message.parts.some((part) => part.kind === "tool-result")
    ? intl.formatMessage({ id: "modelTrajectory.toolOutput" })
    : message.parts.some((part) => part.kind === "tool-call")
      ? intl.formatMessage({ id: "modelTrajectory.toolInput" })
      : null;
  const resolvedVisualRole =
    visualRole ??
    (message.parts.some((part) => part.kind === "tool-result")
      ? "tool-result"
      : message.parts.some((part) => part.kind === "tool-call")
        ? "tool-call"
        : role === "tool"
          ? "tool-result"
          : role);
  const expansionCommand = expansionCommands?.[resolvedVisualRole];
  const persistedExpansion = expansionKey
    ? expansionRegistry?.overrides.get(expansionKey)
    : undefined;
  const rowExpansion = persistedExpansion ?? localExpansion;
  const userOpen =
    expansionCommand && expansionCommand.version > rowExpansion.commandVersion
      ? expansionCommand.expanded
      : rowExpansion.open;
  const searchRevealed = Boolean(expansionKey && expansionKey === searchRevealKey);
  const open = userOpen || searchRevealed;

  const handleCopy = () => {
    if (!copyText || typeof navigator === "undefined" || !navigator.clipboard?.writeText) return;
    void navigator.clipboard.writeText(copyText).catch((error: unknown) => {
      logger.warn("[ModelTrajectory] copy expanded content failed", error);
    });
  };

  const handleOpenChange = (nextOpen: boolean) => {
    const override = {
      open: nextOpen,
      commandVersion: expansionCommand?.version ?? rowExpansion.commandVersion,
    };
    if (expansionKey && expansionRegistry) {
      expansionRegistry.setOverride(expansionKey, override);
    } else {
      setLocalExpansion(override);
    }
  };

  return (
    <Collapsible
      open={open}
      onOpenChange={handleOpenChange}
      data-trajectory-message-role={role}
      data-trajectory-message-collapsible=""
      data-trajectory-expandable-role={resolvedVisualRole}
      data-trajectory-search-target-key={expansionKey}
      data-trajectory-row-alt={isAlt || undefined}
      data-trajectory-user-container={role === "user" ? "" : undefined}
      className={cn(
        "group relative col-span-full grid w-full min-w-0 grid-cols-subgrid",
        isAlt && "bg-surface/30",
      )}
    >
      <div
        data-trajectory-user-summary-card=""
        className="col-span-full grid min-h-8 w-full min-w-0 grid-cols-subgrid items-center"
      >
        <CollapsibleTrigger
          data-trajectory-message-trigger=""
          className="col-span-2 grid min-h-8 min-w-0 grid-cols-subgrid items-center py-0 pl-3 text-left text-ui-sm text-foreground-subtle"
        >
          <span
            data-trajectory-role-label={resolvedVisualRole}
            className={cn(
              "pr-1 font-mono text-ui-sm uppercase",
              trajectoryRoleTextClass(resolvedVisualRole),
            )}
          >
            {roleLabel}
          </span>
          <span className="flex min-w-0 items-center">
            {payloadDirection ? (
              toolPayloadHasError ? (
                <CircleAlertIcon
                  data-trajectory-payload-error-icon=""
                  aria-hidden="true"
                  className="mr-1 size-3.5 shrink-0 text-destructive"
                />
              ) : null
            ) : null}
            {payloadDirection ? (
              <span
                data-trajectory-payload-direction=""
                className={cn(
                  "mr-2 shrink-0 font-mono text-ui-sm uppercase",
                  toolPayloadHasError ? "text-destructive" : "text-foreground",
                )}
              >
                {payloadDirection}
              </span>
            ) : null}
            {payloadDirection ? (
              <ArrowRightIcon
                data-trajectory-payload-arrow=""
                className="mr-2 size-3 shrink-0 text-foreground-subtlest group-data-[state=open]:hidden"
              />
            ) : null}
            <span
              data-trajectory-message-preview=""
              data-trajectory-search-field="content"
              className="min-w-0 flex-1 truncate font-mono group-data-[state=open]:hidden"
            >
              {messagePreview(message, role)}
            </span>
            {toolResultMeta.names ? (
              <Badge
                data-trajectory-tool-result-name=""
                data-trajectory-search-field="tool-name"
                variant="outline"
                className="ml-1.5 h-5 rounded-full border-border bg-tag px-2 font-mono text-ui-xs text-foreground-subtle group-data-[state=open]:hidden"
                title={toolResultMeta.names}
              >
                {toolResultMeta.names}
              </Badge>
            ) : null}
            {toolResultMeta.ids ? (
              <Badge
                data-trajectory-tool-result-id=""
                data-trajectory-search-field="tool-id"
                variant="outline"
                className="ml-1 h-5 max-w-[40%] truncate rounded-full border-border bg-tag px-2 font-mono text-ui-xs text-foreground-subtle group-data-[state=open]:hidden"
                title={toolResultMeta.ids}
              >
                {toolResultMeta.ids}
              </Badge>
            ) : null}
            <span
              data-trajectory-call-metadata=""
              data-trajectory-user-call-metadata={role === "user" ? "" : undefined}
              className="ml-auto mr-7 hidden min-w-0 items-center gap-1 font-mono text-ui-xs text-foreground-subtlest group-data-[state=open]:flex"
            >
              <span>{callDurationLabel}</span>
              <span aria-hidden="true">·</span>
              <span
                data-trajectory-call-datetime=""
                data-trajectory-user-call-datetime={role === "user" ? "" : undefined}
                className="truncate"
                title={callDatetimeTitle}
              >
                {callDatetimeLabel}
              </span>
            </span>
          </span>
          <span className="sr-only group-data-[state=open]:hidden">
            {intl.formatMessage({ id: "modelTrajectory.expand" })}
          </span>
          <span className="sr-only hidden group-data-[state=open]:inline">
            {intl.formatMessage({ id: "modelTrajectory.collapse" })}
          </span>
        </CollapsibleTrigger>
        <span
          data-trajectory-message-actions=""
          className="relative -ml-1 mr-1 flex items-center justify-end"
        >
          <Button
            data-trajectory-message-copy=""
            data-trajectory-user-copy={role === "user" ? "" : undefined}
            type="button"
            variant="ghost"
            size="icon-sm"
            className="absolute right-full mr-1 hidden text-foreground-subtlest group-data-[state=open]:inline-flex"
            aria-label={copyLabel}
            title={copyLabel}
            disabled={!copyText}
            onClick={handleCopy}
          >
            <CopyIcon className="size-3" />
          </Button>
          <CollapsibleTrigger asChild>
            <Button
              data-trajectory-message-chevron-trigger=""
              data-trajectory-user-chevron-trigger={role === "user" ? "" : undefined}
              type="button"
              variant="ghost"
              size="icon-sm"
              className="size-5 rounded-sm text-foreground-subtlest"
            >
              <ChevronRightIcon
                data-trajectory-message-chevron=""
                data-trajectory-user-chevron={role === "user" ? "" : undefined}
                className="size-3 transition-transform group-data-[state=open]:rotate-90"
              />
              <span className="sr-only group-data-[state=open]:hidden">
                {intl.formatMessage({ id: "modelTrajectory.expand" })}
              </span>
              <span className="sr-only hidden group-data-[state=open]:inline">
                {intl.formatMessage({ id: "modelTrajectory.collapse" })}
              </span>
            </Button>
          </CollapsibleTrigger>
        </span>
      </div>
      <CollapsibleContent data-trajectory-message-expanded="" className="col-span-full">
        <TrajectoryExpandedContent
          message={message}
          role={role}
          open={open}
          searchRevealed={searchRevealed}
          intl={intl}
        />
      </CollapsibleContent>
    </Collapsible>
  );
}

function messagePreview(
  message: ZCodeModelTrajectoryMessage,
  role: "system" | "user" | "assistant" | "tool",
): string {
  if (role === "tool" && message.parts.some((part) => part.kind === "tool-result")) {
    return trajectoryToolOutputs(message).join(" ").replaceAll(/\s+/g, " ").trim() || "—";
  }
  const toolCallNames = message.parts.flatMap((part) =>
    part.kind === "tool-call" ? [part.toolName] : [],
  );
  if (toolCallNames.length > 0) {
    return message.parts
      .flatMap((part) => (part.kind === "tool-call" ? [compactPreviewValue(part.input)] : []))
      .join(", ");
  }
  if (role === "user" || role === "assistant") return compactTextPreview(message);
  return firstLinePreview(message);
}

function compactTextPreview(message: ZCodeModelTrajectoryMessage): string {
  const text = message.parts
    .flatMap((part) => ("text" in part && typeof part.text === "string" ? [part.text] : []))
    .join(" ")
    .replaceAll(/\s+/g, " ")
    .trim();
  return text || "—";
}

function compactPreviewValue(value: unknown): string {
  if (typeof value === "string") return value.replaceAll(/\s+/g, " ").trim() || "—";
  const errorText = trajectoryToolPayloadErrorText(value);
  if (errorText !== undefined) return errorText.replaceAll(/\s+/g, " ").trim() || "—";
  if (value === undefined) return "—";
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function firstLinePreview(message: ZCodeModelTrajectoryMessage): string {
  for (const part of message.parts) {
    if ("text" in part && typeof part.text === "string") {
      const firstLine = part.text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean);
      if (firstLine) return firstLine;
    }
  }
  return "—";
}

function messageClipboardText(message: ZCodeModelTrajectoryMessage): string {
  if (message.role === "tool") return trajectoryToolOutputs(message).join("\n\n");
  return message.parts
    .map((part) => {
      if ("text" in part && typeof part.text === "string") return part.text;
      return JSON.stringify(part, null, 2);
    })
    .filter(Boolean)
    .join("\n\n");
}
