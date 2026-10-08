import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { TID_WORKFLOW_ARTIFACT_PANE } from "@zcode/shared";
import type { WorkflowRunArtifactSummary } from "@zcode/shared/zcode-protocol-v4";
import { ChevronLeftIcon, ChevronRightIcon, CopyIcon, FolderOpenIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  ArtifactKindIcon,
  artifactDisplayTitle,
  artifactKindMessageId,
  canRevealArtifactInWorkspace,
  isArtifactPresetKind,
  isTextArtifactContentType,
} from "@/app-shell/workflow-artifacts/artifactPresentation.js";
import { WorkflowArtifactBody } from "@/app-shell/workflow-artifacts/WorkflowArtifactBody.js";
import { useWorkflowRunArtifactBytes } from "@/hooks/useWorkflowRunArtifactBytes.js";
import { useWorkflowRunArtifactData } from "@/hooks/useWorkflowRunArtifactData.js";
import {
  useWorkflowRunArtifacts,
  type WorkflowRunArtifactView,
} from "@/hooks/useWorkflowRunArtifacts.js";
import { joinFilePath } from "@/lib/path.js";
import type { WorkflowArtifactSidePaneTab } from "@/lib/workspaceSidePane.js";
import { useZCodeStoreWithDefault } from "@/store/StoreProvider.js";
import { resolveTheme, type Theme } from "@/useTheme.js";
import type { PaneWorkspaceScope } from "@/v4/paneLayoutStore.js";
import type { SessionLease } from "@/v4/sessionDataLayer.js";
import { useConversationProjection } from "@/v4/useConversationProjection.js";
import { useV4Conversation, V4PaneConversationProvider } from "@/v4/V4ConversationContext.js";

/**
 * 稳定引用的空摘要列表：`artifacts` 键在零产物时**缺席**，坍缩成一个每帧新造的 `[]`
 * 会让合并 hook 的依赖每帧都变，于是每帧重查一次 journal。
 */
const EMPTY_SUMMARIES: readonly WorkflowRunArtifactSummary[] = [];

const WorkflowArtifactContent = memo(function WorkflowArtifactContent({
  tab,
  onOpenBrowserUrl,
  onRevealFileInTree,
}: {
  tab: WorkflowArtifactSidePaneTab;
  onOpenBrowserUrl?: (url: string) => void;
  onRevealFileInTree?: (path: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const { layer } = useV4Conversation();
  const [lease, setLease] = useState<SessionLease | null>(null);
  const theme = useZCodeStoreWithDefault((state) => state.theme, "system");

  // 订阅**父会话**的投影（照 PlanDetail / WorkflowRun 详情页）：产物的新鲜元数据是父会话
  // 投影的一部分，不是这个面板的本地缓存。
  useEffect(() => {
    const nextLease = layer.acquire(tab.parentSessionId);
    setLease(nextLease);
    return () => nextLease.release();
  }, [layer, tab.parentSessionId]);
  const state = useConversationProjection(lease);
  const run = useMemo(
    () => state.snapshot?.workflowRuns?.runs.find((candidate) => candidate.runId === tab.runId),
    [state.snapshot?.workflowRuns, tab.runId],
  );
  // run 不在活投影里（冷恢复 / 被 8-run 上限淘汰）⇒ 整份清单走 journal；在场但零产物 ⇒ 空数组。
  const live = run === undefined ? undefined : (run.artifacts ?? EMPTY_SUMMARIES);
  const {
    artifacts,
    loading: metadataLoading,
    unavailable,
  } = useWorkflowRunArtifacts({
    sessionId: tab.parentSessionId,
    runId: tab.runId,
    ...(live === undefined ? {} : { live }),
  });

  const artifact = useMemo(
    () => artifacts.find((candidate) => candidate.id === tab.artifactId),
    [artifacts, tab.artifactId],
  );

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-background"
      data-artifact-source={live === undefined ? "journal" : "live"}
      data-testid={TID_WORKFLOW_ARTIFACT_PANE}
      data-workflow-artifact-id={tab.artifactId}
      data-workflow-run-id={tab.runId}
    >
      {artifact === undefined ? (
        // 三态必须分开：还在读 / 这个会话读不到产物详情（老 CLI）/ 读完了但这个 id 不在
        // （run 的 journal 已被清理，或 chip 指向的产物不存在）。合并成一句「正在读取」的
        // 结果是最后一种情形永远停在加载文案上。
        <div className="flex h-full items-center justify-center p-6 text-center">
          <p
            className="text-ui-base text-foreground-subtle"
            data-testid="workflow-artifact-placeholder"
          >
            {intl.formatMessage({
              id: metadataLoading
                ? "chat.toolCall.workflow.run.artifacts.loading"
                : unavailable
                  ? "chat.toolCall.workflow.run.artifacts.unavailable"
                  : "chat.toolCall.workflow.run.artifacts.missing",
            })}
          </p>
        </div>
      ) : (
        <WorkflowArtifactView
          artifact={artifact}
          metadataLoading={metadataLoading}
          tab={tab}
          theme={theme}
          {...(onOpenBrowserUrl === undefined ? {} : { onOpenBrowserUrl })}
          {...(onRevealFileInTree === undefined ? {} : { onRevealFileInTree })}
        />
      )}
    </div>
  );
});

/**
 * 头部 + 正文。产物已确定在场时才挂载，所以字节与条目的两个 hook 在这里可以无条件调用
 * （产物缺席那一帧根本不渲染这个组件，hooks 数量因此恒定）。
 */
function WorkflowArtifactView({
  artifact,
  metadataLoading,
  tab,
  theme,
  onOpenBrowserUrl,
  onRevealFileInTree,
}: {
  artifact: WorkflowRunArtifactView;
  /** 元数据（含预置看板的 spec）还在读；正文据此区分「还没到」与「真的没有」。 */
  metadataLoading: boolean;
  tab: WorkflowArtifactSidePaneTab;
  theme: Theme;
  onOpenBrowserUrl?: (url: string) => void;
  onRevealFileInTree?: (path: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const preset = isArtifactPresetKind(artifact.kind);

  // 版本步进器的落点。tab 上的 `version` 只是**打开时**的初始值（chip 从不带版本号，
  // 缺席即最新版）；之后由用户翻。产物换了（同一个 tab 不会，但组件可能被复用）或最新版
  // 抬升时重置回最新版——正在看历史版本时新版落地，跳走会很突兀，所以只在 id 变化时重置。
  const [selectedVersion, setSelectedVersion] = useState<number | undefined>(tab.version);
  useEffect(() => {
    setSelectedVersion(tab.version);
  }, [artifact.id, tab.version]);

  const availableVersions = useMemo(() => {
    if (artifact.versions !== undefined && artifact.versions.length > 0) {
      return artifact.versions.map((entry) => entry.version);
    }
    // journal 读不到（老 CLI / 读失败）时只有最新版可看——不要凭 `version` 编造 1..n，
    // 那会让步进器指向一批取不到字节的版本号。
    return [artifact.version];
  }, [artifact.version, artifact.versions]);

  const version =
    selectedVersion !== undefined && availableVersions.includes(selectedVersion)
      ? selectedVersion
      : artifact.version;
  const versionIndex = availableVersions.indexOf(version);
  const isLatestVersion = version === artifact.version;

  const bytesState = useWorkflowRunArtifactBytes({
    sessionId: tab.parentSessionId,
    runId: tab.runId,
    artifactId: artifact.id,
    version,
    enabled: !preset,
  });
  const dataState = useWorkflowRunArtifactData({
    sessionId: tab.parentSessionId,
    runId: tab.runId,
    artifactId: artifact.id,
    itemCount: artifact.itemCount,
    enabled: preset,
  });

  // 「在工作区显示」与 html 的「在浏览器中打开」共用这一条路径：工作区相对的 `sourcePath`
  // 拼上 workspacePath 才是本机上真实存在的位置。远程 workspace 与无出处的产物都得不到它。
  const sourcePath = artifact.sourcePath;
  const localSourcePath =
    sourcePath !== undefined &&
    canRevealArtifactInWorkspace({
      sourcePath,
      ...(tab.workspaceIdentity === undefined ? {} : { workspaceIdentity: tab.workspaceIdentity }),
      ...(tab.remoteSessionId === undefined ? {} : { remoteSessionId: tab.remoteSessionId }),
    })
      ? joinFilePath(tab.workspacePath, sourcePath)
      : undefined;

  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  const copyable =
    !preset && bytesState.bytes !== null && isTextArtifactContentType(artifact.contentType);
  const handleCopy = useCallback(() => {
    if (bytesState.bytes === null) return;
    void navigator.clipboard
      ?.writeText(new TextDecoder().decode(bytesState.bytes))
      .then(() => setCopied(true))
      .catch(() => undefined);
  }, [bytesState.bytes]);

  const title = artifactDisplayTitle(artifact);
  const kindLabel = intl.formatMessage({ id: artifactKindMessageId(artifact.kind) });

  return (
    <>
      <header className="shrink-0 border-b border-border px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          {/* 与产物药丸同一枚方形瓦片：tab 头就是那枚药丸长大了。 */}
          <span className="flex size-[22px] shrink-0 items-center justify-center rounded-md bg-surface-hover text-foreground-subtle">
            <ArtifactKindIcon className="size-3.5" kind={artifact.kind} />
          </span>
          <h2
            className="min-w-0 flex-1 truncate text-ui-base font-medium text-foreground"
            data-testid="workflow-artifact-title"
            title={title}
          >
            {title}
          </h2>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span className="text-ui-sm text-foreground-subtle">{kindLabel}</span>
          <ArtifactVersionStepper
            availableVersions={availableVersions}
            onSelect={setSelectedVersion}
            version={version}
            versionIndex={versionIndex}
          />
          <div className="ml-auto flex items-center gap-1">
            {localSourcePath !== undefined && onRevealFileInTree !== undefined ? (
              <Button
                data-testid="workflow-artifact-reveal"
                onClick={() => onRevealFileInTree(localSourcePath)}
                size="sm"
                type="button"
                variant="ghost"
              >
                <FolderOpenIcon aria-hidden="true" className="size-3.5" />
                {intl.formatMessage({ id: "chat.toolCall.workflow.run.artifacts.reveal" })}
              </Button>
            ) : null}
            {copyable ? (
              <Button
                data-testid="workflow-artifact-copy"
                onClick={handleCopy}
                size="sm"
                type="button"
                variant="ghost"
              >
                <CopyIcon aria-hidden="true" className="size-3.5" />
                {intl.formatMessage({
                  id: copied
                    ? "chat.toolCall.workflow.run.artifacts.copied"
                    : "chat.toolCall.workflow.run.artifacts.copy",
                })}
              </Button>
            ) : null}
          </div>
        </div>
        {/* 作者写的说明（用户语言）；缺席即整行不渲染。 */}
        {artifact.description === undefined ? null : (
          <p className="mt-1.5 text-ui-sm text-foreground-subtle">{artifact.description}</p>
        )}
      </header>

      <div className="min-h-0 flex-1">
        <WorkflowArtifactBody
          artifact={artifact}
          blob={bytesState.blob}
          bytes={bytesState.bytes}
          error={bytesState.error}
          isLatestVersion={isLatestVersion}
          items={dataState.items}
          loading={bytesState.loading}
          metadataLoading={metadataLoading}
          objectUrl={bytesState.objectUrl}
          resolvedTheme={resolveTheme(theme)}
          theme={theme}
          version={version}
          {...(localSourcePath === undefined ? {} : { localSourcePath })}
          {...(onOpenBrowserUrl === undefined ? {} : { onOpenBrowserUrl })}
          {...(localSourcePath !== undefined && onRevealFileInTree !== undefined
            ? { onReveal: () => onRevealFileInTree(localSourcePath) }
            : {})}
        />
      </div>
    </>
  );
}

/**
 * 版本步进器 `‹ v2 / 3 ›`。只有一版时整块缺席——一个永远两端禁用的步进器只是噪声。
 *
 * 按**已知版本的数组**翻而不是按数字加减：journal 读不到时数组里只有最新版一个数，
 * 那时步进器自然消失，而不是给出一批取不到字节的版本号。
 */
function ArtifactVersionStepper({
  availableVersions,
  version,
  versionIndex,
  onSelect,
}: {
  availableVersions: readonly number[];
  version: number;
  versionIndex: number;
  onSelect: (version: number) => void;
}) {
  const { intl } = useZCodeIntl();
  if (availableVersions.length <= 1) {
    return (
      <span
        className="font-mono text-ui-xs text-foreground-subtlest"
        data-testid="workflow-artifact-version"
      >
        {intl.formatMessage(
          { id: "chat.toolCall.workflow.run.artifacts.version" },
          { version: String(version) },
        )}
      </span>
    );
  }
  const previous = availableVersions[versionIndex - 1];
  const next = availableVersions[versionIndex + 1];
  return (
    <div className="flex items-center gap-0.5" data-testid="workflow-artifact-version-stepper">
      <Button
        aria-label={intl.formatMessage({
          id: "chat.toolCall.workflow.run.artifacts.previousVersion",
        })}
        data-testid="workflow-artifact-version-previous"
        disabled={previous === undefined}
        onClick={() => (previous === undefined ? undefined : onSelect(previous))}
        size="icon-sm"
        type="button"
        variant="ghost"
      >
        <ChevronLeftIcon aria-hidden="true" className="size-3.5" />
      </Button>
      <span
        className="font-mono text-ui-xs text-foreground-subtle"
        data-testid="workflow-artifact-version"
      >
        {intl.formatMessage(
          { id: "chat.toolCall.workflow.run.artifacts.versionOf" },
          { total: String(availableVersions.length), version: String(version) },
        )}
      </span>
      <Button
        aria-label={intl.formatMessage({ id: "chat.toolCall.workflow.run.artifacts.nextVersion" })}
        data-testid="workflow-artifact-version-next"
        disabled={next === undefined}
        onClick={() => (next === undefined ? undefined : onSelect(next))}
        size="icon-sm"
        type="button"
        variant="ghost"
      >
        <ChevronRightIcon aria-hidden="true" className="size-3.5" />
      </Button>
    </div>
  );
}

/**
 * 一个 dwf 产物的全尺寸查看 tab。
 *
 * ⚠ 术语：这里的 artifact 是脚本经 `artifact.*` 交付给用户的产出，不是引擎内部那个
 * 「脚本顶层返回值」的同名词。
 *
 * 数据分三条：**元数据**走 `useWorkflowRunArtifacts`（活投影 + journal 合并），
 * **字节**走 `useWorkflowRunArtifactBytes`（分块拼 Blob），**看板条目**走
 * `useWorkflowRunArtifactData`（`itemCount` 抬升即增量续拉）。三条互不相干，
 * 所以一个看板永远不会去读字节，一份 pdf 也永远不会去翻 journal 的 report 行。
 */
export const WorkflowArtifactSidePane = memo(function WorkflowArtifactSidePane({
  tab,
  onOpenBrowserUrl,
  onRevealFileInTree,
}: {
  tab: WorkflowArtifactSidePaneTab;
  /** html 产物的「在浏览器中打开」。 */
  onOpenBrowserUrl?: (url: string) => void;
  /** 「在工作区显示」：复用既有的文件树 reveal（与 Git 面板同一条路径）。 */
  onRevealFileInTree?: (path: string) => void;
}) {
  const scope = useMemo<PaneWorkspaceScope>(
    () => ({
      workspacePath: tab.workspacePath,
      ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
      ...(tab.remoteSessionId ? { remoteSessionId: tab.remoteSessionId } : {}),
    }),
    [tab.remoteSessionId, tab.workspaceIdentity, tab.workspacePath],
  );

  return (
    <V4PaneConversationProvider scope={scope}>
      <WorkflowArtifactContent
        tab={tab}
        {...(onOpenBrowserUrl === undefined ? {} : { onOpenBrowserUrl })}
        {...(onRevealFileInTree === undefined ? {} : { onRevealFileInTree })}
      />
    </V4PaneConversationProvider>
  );
});
