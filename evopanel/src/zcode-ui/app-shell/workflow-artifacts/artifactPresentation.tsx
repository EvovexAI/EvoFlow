import type { ReactNode } from "react";
import { ChartLineIcon, FileIcon, GaugeIcon, SquareKanbanIcon, TableIcon } from "lucide-react";
import type { WorkflowRunArtifactKind } from "@zcode/shared/zcode-protocol-v4";
import { FileDisplayIcon, resolveFileDisplayDescriptor } from "@/lib/fileDisplay.js";
import type {
  ArtifactPresetKind,
  PresetLabels,
} from "@/app-shell/workflow-artifacts/presets/index.js";

/**
 * 用户面产物在**几个表面**（run 侧板瓦片、完成卡瓦片、`workflow-artifact` tab、通知行药丸、中枢）
 * 共用的呈现规则。
 *
 * ⚠ 术语：这里的 artifact 是脚本经 `artifact.*` 发布给用户的产出，不是引擎内部
 * 「脚本顶层返回值」的同名词。
 *
 * 抽出来的理由只有一条：**同一个产物在四处必须长得一样**。图标或 kind 词各写一遍，
 * 通知行的 chip 与它点开的 tab 迟早会用两枚不同的图标指同一件东西。
 */

/** 四个预置看板成员。内容成员（file / markdown）有字节与版本，它们没有。 */
const PRESET_KINDS = new Set<WorkflowRunArtifactKind>(["chart", "table", "metrics", "board"]);

export function isArtifactPresetKind(kind: WorkflowRunArtifactKind): kind is ArtifactPresetKind {
  return PRESET_KINDS.has(kind);
}

/** kind 词的 message id。六个成员各一个词（文件 / 文档 / 图表 / 表格 / 指标 / 看板）。 */
export function artifactKindMessageId(kind: WorkflowRunArtifactKind): string {
  return `chat.toolCall.workflow.run.artifacts.kind.${kind}`;
}

const MARKDOWN_ICON = resolveFileDisplayDescriptor("artifact.md").fileIconSrc;
const KIND_ICON: Record<Exclude<WorkflowRunArtifactKind, "markdown">, typeof FileIcon> = {
  file: FileIcon,
  chart: ChartLineIcon,
  table: TableIcon,
  metrics: GaugeIcon,
  board: SquareKanbanIcon,
};

/**
 * kind 图标。`className` 由调用方给尺寸（卡片 size-4、chip size-3.5、tab 头部 size-4）——
 * 尺寸是各表面的密度决定的，图形本身不是。
 */
export function ArtifactKindIcon({
  kind,
  className,
}: {
  kind: WorkflowRunArtifactKind;
  className?: string;
}): ReactNode {
  if (kind === "markdown") {
    return <FileDisplayIcon src={MARKDOWN_ICON} className={className} />;
  }
  const Icon = KIND_ICON[kind];
  return <Icon aria-hidden="true" className={className} />;
}

/**
 * 字节数的展示写法。
 *
 * 刻意在本模块另写一份而不是 import `feedback/feedbackSubmissionJob.ts` 里那个同名函数：
 * 那是反馈上传作业模块，为了五行算术把整条上传链路拖进 app-shell 的依赖图不划算，
 * 而两者若漂移也不会有人受害（一个说文件多大，一个说传了多少）。
 */
export function formatArtifactBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/**
 * 这个 contentType 的正文是不是**人能读的文本**——「复制」动作的门。
 *
 * `application/json` 单独列出来的理由：它按 IANA 归在 application/ 下，但脚本用
 * `artifact.file("summary", "out/report.json")` 交出来的东西，用户想要的就是把它复制走。
 * 与正文分派用的 `textLanguageFor` 是两件事：那个决定用哪个 code viewer，这个只决定
 * 「能不能整份复制」。
 */
export function isTextArtifactContentType(contentType: string | undefined): boolean {
  if (contentType === undefined) return false;
  return contentType.startsWith("text/") || contentType === "application/json";
}

/** 文件的类型徽字：工作区原路径的扩展名优先（`out/book.pdf` → `PDF`），没有路径时退回 MIME 子类型。 */
export function artifactFileBadge(artifact: {
  sourcePath?: string;
  contentType?: string;
}): string | undefined {
  const extension = artifact.sourcePath?.match(/\.([a-z0-9]{1,5})$/iu)?.[1];
  if (extension !== undefined) return extension.toUpperCase();
  const subtype = artifact.contentType?.split("/")[1]?.split(";")[0]?.trim();
  if (subtype === undefined || subtype.length === 0) return undefined;
  const KNOWN: Record<string, string> = {
    "x-markdown": "MD",
    markdown: "MD",
    plain: "TXT",
    json: "JSON",
    csv: "CSV",
    html: "HTML",
    pdf: "PDF",
  };
  return KNOWN[subtype] ?? (subtype.length <= 5 ? subtype.toUpperCase() : undefined);
}

/**
 * 药丸 / 瓦片说明行里的等宽细节：文件 `PDF · 4.0 KB`，文档只有大小，预置看板是喂进来的条数
 * （它的「大小」是数据量；条数不知道时缺席）。侧板瓦片与完成卡共用——两处各写一份，迟早一处
 * 说了徽字另一处没说。返回 null 即调用方不画细节槽。
 */
export function ArtifactDetail({
  artifact,
  labels,
}: {
  artifact: {
    kind: WorkflowRunArtifactKind;
    bytes?: number;
    itemCount?: number;
    sourcePath?: string;
    contentType?: string;
  };
  labels: PresetLabels;
}): ReactNode {
  if (isArtifactPresetKind(artifact.kind)) {
    return artifact.itemCount === undefined ? null : (
      <span data-testid="workflow-run-artifact-items">{labels.itemsCount(artifact.itemCount)}</span>
    );
  }
  if (artifact.bytes === undefined) return null;
  const badge = artifact.kind === "file" ? artifactFileBadge(artifact) : undefined;
  return (
    <>
      {badge === undefined ? null : (
        <>
          <span data-testid="workflow-run-artifact-badge">{badge}</span>
          <span aria-hidden>·</span>
        </>
      )}
      <span data-testid="workflow-run-artifact-bytes">{formatArtifactBytes(artifact.bytes)}</span>
    </>
  );
}

/**
 * 说明行细节的**纯文本**写法（`PDF · 4.0 KB` / `4 items`）：迷你瓦片把细节挪进 tooltip，
 * 交付物行把它写进 `kind · size` 那一行。与 `ArtifactDetail` 同一套规则，只是没有 testid。
 */
export function artifactDetailText(
  artifact: {
    kind: WorkflowRunArtifactKind;
    bytes?: number;
    itemCount?: number;
    sourcePath?: string;
    contentType?: string;
  },
  labels: PresetLabels,
): string | undefined {
  if (isArtifactPresetKind(artifact.kind)) {
    return artifact.itemCount === undefined ? undefined : labels.itemsCount(artifact.itemCount);
  }
  if (artifact.bytes === undefined) return undefined;
  const badge = artifact.kind === "file" ? artifactFileBadge(artifact) : undefined;
  const size = formatArtifactBytes(artifact.bytes);
  return badge === undefined ? size : `${badge} · ${size}`;
}

/**
 * 交付物：打了 `primary` 旗子的那一件；没有旗子而清单
 * 只有一件时，那一件就是交付物——**单件规则只在 UI 上成立**，协议与引擎从不推断旗子。其余情形
 * 没有交付物：发布失败的 primary 不由别的产物顶替，两件以上无旗子就是今天的画法。
 */
export function resolvePrimaryArtifact<T extends { primary?: true }>(
  artifacts: readonly T[],
): T | undefined {
  const flagged = artifacts.find((artifact) => artifact.primary === true);
  if (flagged !== undefined) return flagged;
  return artifacts.length === 1 ? artifacts[0] : undefined;
}

/**
 * 交付物带头，其余保持原顺序。CLI 的三处投影（journal → 端口、通知清单、GetWorkflowRun）已经
 * 这样排过；这里是**活投影那条路**（`workflowRuns[].artifacts` 按发布顺序 upsert）唯一的排序点。
 */
export function orderArtifactsPrimaryFirst<T extends { primary?: true }>(
  artifacts: readonly T[],
): T[] {
  const index = artifacts.findIndex((artifact) => artifact.primary === true);
  if (index <= 0) return [...artifacts];
  return [artifacts[index]!, ...artifacts.slice(0, index), ...artifacts.slice(index + 1)];
}

/** 卡片标题：作者写的 title 优先，缺席退回 id（facade 的缺省 title 本来就是 id）。 */
export function artifactDisplayTitle(artifact: { id: string; title?: string }): string {
  return artifact.title?.trim() || artifact.id;
}

/** chip 上的标题截断长度。 */
const ARTIFACT_CHIP_TITLE_MAX_LENGTH = 24;

/** 通知行 / 中枢行一次最多摆几枚 chip，其余折进「+N」。 */
export const ARTIFACT_CHIP_MAX_VISIBLE = 3;

export function truncateArtifactChipTitle(title: string): string {
  return title.length > ARTIFACT_CHIP_TITLE_MAX_LENGTH
    ? `${title.slice(0, ARTIFACT_CHIP_TITLE_MAX_LENGTH)}…`
    : title;
}

/**
 * 喂给四个预置渲染器的三句译文。渲染器自己不查 i18n（它要能被侧板 / tab / 中枢复用），
 * 所以每个表面在自己的 intl 语境里造一份。
 */
export function buildPresetLabels(
  formatMessage: (descriptor: { id: string }, values?: Record<string, string>) => string,
): PresetLabels {
  return {
    otherColumn: formatMessage({
      id: "chat.toolCall.workflow.run.artifacts.preset.otherColumn",
    }),
    empty: formatMessage({ id: "chat.toolCall.workflow.run.artifacts.preset.empty" }),
    itemsCount: (count: number) =>
      formatMessage(
        { id: "chat.toolCall.workflow.run.artifacts.preset.items" },
        { count: String(count) },
      ),
  };
}

/**
 * 该产物能不能在**本地文件系统**上被定位（「在工作区显示」与 html 的「在浏览器中打开」的门）。
 *
 * 判据与 `shouldOpenAssistantHtmlInBrowser` 同源：远程 workspace（SSH / WSL / Docker）
 * 的路径在本机不存在，手机远控也没有文件树可以跳。`sourcePath` 缺席则连路径都没有——
 * markdown 产物与预置看板天生就没有出处。
 */
export function canRevealArtifactInWorkspace(params: {
  sourcePath?: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}): boolean {
  return (
    Boolean(params.sourcePath?.trim()) &&
    !params.workspaceIdentity?.trim() &&
    !params.remoteSessionId
  );
}
