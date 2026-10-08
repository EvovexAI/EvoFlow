import { lazy, Suspense, useMemo } from "react";
import type { FileBinaryPreview } from "@zcode/shared";
import { CodeBlock } from "@/components/ai-elements/code-block.js";
import { MessageResponse } from "@/components/ai-elements/message.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  buildPresetLabels,
  isArtifactPresetKind,
} from "@/app-shell/workflow-artifacts/artifactPresentation.js";
import { ArtifactPresetBody } from "@/app-shell/workflow-artifacts/ArtifactPresetBody.js";
import {
  ArtifactMetadataCard,
  ArtifactNotice,
  WorkflowArtifactHtmlCard,
} from "@/app-shell/workflow-artifacts/WorkflowArtifactCards.js";
import type { ArtifactItem } from "@/app-shell/workflow-artifacts/presets/index.js";
import type { WorkflowRunArtifactView } from "@/hooks/useWorkflowRunArtifacts.js";
import { encodeBytesToBase64 } from "@/hooks/useWorkflowRunArtifactBytes.js";
import { usePdfViewerLabels, usePptxViewerLabels } from "@/hooks/usePreviewViewerLabels.js";
import type { Theme } from "@/useTheme.js";

/**
 * `workflow-artifact` tab 的正文。
 *
 * ⚠ 术语：artifact = 脚本经 `artifact.*` 发布给用户看的产出。
 *
 * **零新渲染依赖**：pdf / 图片 / markdown / office / 文本全部走既有的叶子查看器，预置看板走
 * 4b 的四个渲染器。分派的判据是 journal 记录上的 `contentType`——它由 driver 按扩展名表算出、
 * 可被 `opts.contentType` 覆盖，是这条链路唯一的类型真相（store 读回来时会自己重新嗅一次，
 * 那个值刻意不用）。
 *
 * **刻意不做 iframe**：renderer 没有 CSP，`allow-scripts allow-same-origin` 的 sandbox 组合
 * 等价于逃逸。html 因此走既有的浏览器 tab（见 `WorkflowArtifactHtmlCard`）。
 */

// 三个重量级查看器都懒加载：pdf.js / docx-preview / xlsx wasm 各自都是几百 KB，
// 而绝大多数会话从不打开产物 tab。既有的 previewPane* 包装本身已经带 Suspense。
const PdfPreviewContent = lazy(() =>
  import("@/previewPanePdfContent.js").then((module) => ({ default: module.PdfPreviewContent })),
);
const PptxPreviewContent = lazy(() =>
  import("@/previewPanePptxContent.js").then((module) => ({ default: module.PptxPreviewContent })),
);
const PreviewPaneOfficeContent = lazy(() =>
  import("@/previewPaneOfficeContent.js").then((module) => ({
    default: module.PreviewPaneOfficeContent,
  })),
);

const PPTX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const DOCX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** 文本类：正文用等宽 code viewer 呈现。`text/markdown` 不在其中——它走 MessageResponse。 */
function textLanguageFor(contentType: string): string | undefined {
  if (contentType === "application/json") return "json";
  if (contentType === "text/csv") return "csv";
  if (contentType === "text/plain") return "text";
  if (contentType.startsWith("text/")) return "text";
  return undefined;
}

interface WorkflowArtifactBodyProps {
  artifact: WorkflowRunArtifactView;
  /** 正在查看的版本；内容产物的字节按它读。 */
  version: number;
  bytes: Uint8Array<ArrayBuffer> | null;
  blob: Blob | null;
  objectUrl: string | null;
  /** 字节读取的状态：loading 与 error 都由本组件呈现（各查看器自己的 loading 只覆盖解析）。 */
  loading: boolean;
  error: string | null;
  /** 预置看板的条目流；内容产物恒空。 */
  items: readonly ArtifactItem[];
  theme: Theme;
  resolvedTheme: "light" | "dark";
  /** html 的「在浏览器中打开」；缺席即只显示提示。 */
  onOpenBrowserUrl?: (url: string) => void;
  /** 本地文件系统上的绝对路径（desktop-local ∧ `sourcePath` 在场时才有）。 */
  localSourcePath?: string;
  /** 「在工作区显示」：已绑定好路径的文件树 reveal；缺席即无渲染器的卡片上不出这个按钮。 */
  onReveal?: () => void;
  /** 查看的是不是最新版——旧版的工作区原文件早就被覆盖了，html 预览因此只对最新版开放。 */
  isLatestVersion: boolean;
  /** 元数据（含预置看板的 spec）还在读；预置正文据此区分「还没到」与「真的没有」。 */
  metadataLoading: boolean;
}

export function WorkflowArtifactBody(props: WorkflowArtifactBodyProps) {
  const { intl } = useZCodeIntl();
  const { artifact } = props;

  // 预置看板不读字节，直接画。
  if (isArtifactPresetKind(artifact.kind)) {
    const labels = buildPresetLabels((descriptor, values) =>
      intl.formatMessage(descriptor, values),
    );
    return (
      <div className="h-full min-h-0 overflow-auto p-4" data-artifact-body="preset">
        <ArtifactPresetBody
          artifact={artifact}
          items={props.items}
          labels={labels}
          invalidLabel={intl.formatMessage({
            id: "chat.toolCall.workflow.run.artifacts.presetInvalid",
          })}
          // spec 只有 journal 查询带得回来，所以**元数据读完之前**不能说「读不到」——
          // 否则每个看板打开时都先闪一次错误文案。
          {...(props.metadataLoading
            ? {}
            : {
                missingLabel: intl.formatMessage({
                  id: "chat.toolCall.workflow.run.artifacts.unavailable",
                }),
              })}
        />
      </div>
    );
  }

  if (props.error !== null) {
    return (
      <ArtifactNotice
        testId="workflow-artifact-error"
        tone="error"
        text={intl.formatMessage({ id: "chat.toolCall.workflow.run.artifacts.loadError" })}
        detail={props.error}
      />
    );
  }
  if (props.loading || props.bytes === null) {
    return (
      <ArtifactNotice
        testId="workflow-artifact-loading"
        text={intl.formatMessage({ id: "chat.toolCall.workflow.run.artifacts.loading" })}
      />
    );
  }

  return <WorkflowArtifactContent {...props} bytes={props.bytes} />;
}

/**
 * 字节已就绪之后的分派。拆成第二个组件的理由是 hooks：markdown 的解码、office 的 base64
 * 回程都得用 `useMemo`，而它们在「还没读到字节」的那一帧不能被跳过（hooks 数量必须恒定）。
 */
function WorkflowArtifactContent({
  artifact,
  bytes,
  blob,
  objectUrl,
  theme,
  resolvedTheme,
  onOpenBrowserUrl,
  onReveal,
  localSourcePath,
  isLatestVersion,
}: WorkflowArtifactBodyProps & { bytes: Uint8Array<ArrayBuffer> }) {
  const { intl } = useZCodeIntl();
  const pdfLabels = usePdfViewerLabels();
  const pptxLabels = usePptxViewerLabels();
  const contentType = artifact.contentType ?? "application/octet-stream";

  // 文本三态（markdown / 代码 / html 源）共用一次解码。TextDecoder 在 renderer 里恒在。
  const text = useMemo(() => {
    if (
      contentType !== "text/markdown" &&
      contentType !== "text/html" &&
      textLanguageFor(contentType) === undefined
    ) {
      return undefined;
    }
    return new TextDecoder().decode(bytes);
  }, [bytes, contentType]);

  // office 查看器只吃 `FileBinaryPreview.dataBase64`，所以这里走一次回程编码。
  // 只在真的是 office 文件时才算——20 MiB 的 base64 不该为一份 pdf 白算一遍。
  const officePreview = useMemo<FileBinaryPreview | null>(() => {
    if (contentType !== DOCX_CONTENT_TYPE && contentType !== XLSX_CONTENT_TYPE) return null;
    return {
      path: artifact.sourcePath ?? artifact.id,
      dataBase64: encodeBytesToBase64(bytes),
      totalBytes: bytes.length,
    };
  }, [artifact.id, artifact.sourcePath, bytes, contentType]);

  // pptx 查看器吃 ArrayBuffer。`slice` 出一份独立缓冲：Uint8Array 的 buffer 可能带偏移。
  const pptxBuffer = useMemo(
    () =>
      contentType === PPTX_CONTENT_TYPE
        ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
        : null,
    [bytes, contentType],
  );

  if (contentType === "text/markdown") {
    return (
      // markdown 必须**传 theme**：portfolio 修过一次深底深字（渲染器按 theme 选代码块配色）。
      <div className="h-full min-h-0 overflow-y-auto px-4 py-4" data-artifact-body="markdown">
        <MessageResponse
          className="mx-auto w-full min-w-0 max-w-4xl break-words text-foreground"
          theme={theme}
        >
          {text ?? ""}
        </MessageResponse>
      </div>
    );
  }

  if (contentType === "application/pdf") {
    return (
      <div className="h-full min-h-0" data-artifact-body="pdf">
        <Suspense fallback={<ArtifactNotice text={pdfLabels.loading} />}>
          {/* PdfViewerSource 接受 Blob——不必落地成文件也不必走 range transport。 */}
          <PdfPreviewContent labels={pdfLabels} source={blob ?? new Blob([bytes])} />
        </Suspense>
      </div>
    );
  }

  if (contentType.startsWith("image/")) {
    return (
      <div
        className="flex h-full min-h-0 items-center justify-center overflow-auto bg-background-alt p-4"
        data-artifact-body="image"
      >
        {objectUrl === null ? (
          <ArtifactNotice
            text={intl.formatMessage({ id: "chat.toolCall.workflow.run.artifacts.loadError" })}
            tone="error"
          />
        ) : (
          <img
            alt={artifact.title ?? artifact.id}
            className="max-h-full max-w-full object-contain"
            data-testid="workflow-artifact-image"
            src={objectUrl}
          />
        )}
      </div>
    );
  }

  if (contentType === PPTX_CONTENT_TYPE && pptxBuffer !== null) {
    return (
      <div className="h-full min-h-0" data-artifact-body="pptx">
        <Suspense fallback={<ArtifactNotice text={pptxLabels.loading} />}>
          <PptxPreviewContent
            data={pptxBuffer}
            fileName={artifact.sourcePath ?? artifact.id}
            labels={pptxLabels}
            {...(onOpenBrowserUrl === undefined ? {} : { onOpenBrowserUrl })}
          />
        </Suspense>
      </div>
    );
  }

  if (officePreview !== null) {
    return (
      <div className="h-full min-h-0" data-artifact-body="office">
        <Suspense fallback={<ArtifactNotice text={pdfLabels.loading} />}>
          <PreviewPaneOfficeContent
            error={null}
            kind={contentType === XLSX_CONTENT_TYPE ? "excel" : "docx"}
            loading={false}
            preview={officePreview}
            resolvedTheme={resolvedTheme}
            sourcePath={artifact.sourcePath ?? artifact.id}
            {...(onOpenBrowserUrl === undefined ? {} : { onOpenBrowserUrl })}
          />
        </Suspense>
      </div>
    );
  }

  if (contentType === "text/html") {
    return (
      <WorkflowArtifactHtmlCard
        artifact={artifact}
        bytes={bytes.length}
        isLatestVersion={isLatestVersion}
        {...(localSourcePath === undefined ? {} : { localSourcePath })}
        {...(onOpenBrowserUrl === undefined ? {} : { onOpenBrowserUrl })}
        {...(onReveal === undefined ? {} : { onReveal })}
      />
    );
  }

  const language = textLanguageFor(contentType);
  if (language !== undefined && text !== undefined) {
    return (
      <div className="h-full min-h-0 overflow-auto" data-artifact-body="text">
        <CodeBlock appTheme={theme} code={text} language={language} showLineNumbers />
      </div>
    );
  }

  // 表外类型（`application/octet-stream` 与一切没人认得的东西）：给一张**元数据卡**，
  // 不假装能渲染。卡上带「在工作区显示」——那是这种产物唯一能对它做的事（没有「下载」：
  // renderer 没有任何把字节存成用户文件的宿主能力）。
  return (
    <ArtifactMetadataCard
      artifact={artifact}
      bytes={bytes.length}
      note={intl.formatMessage({ id: "chat.toolCall.workflow.run.artifacts.unsupported" })}
      testId="workflow-artifact-unsupported"
      {...(onReveal === undefined
        ? {}
        : {
            action: {
              label: intl.formatMessage({ id: "chat.toolCall.workflow.run.artifacts.reveal" }),
              onActivate: onReveal,
              testId: "workflow-artifact-unsupported-reveal",
            },
          })}
    />
  );
}
