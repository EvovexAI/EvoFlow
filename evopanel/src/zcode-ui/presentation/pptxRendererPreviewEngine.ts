import {
  RECOMMENDED_ZIP_LIMITS,
  buildTextIndex,
  buildPresentation,
  materializeSlideNodes,
  parseZipLazyMedia,
  renderSlide,
} from "@aiden0z/pptx-renderer/browser";
import type { SlideHandle } from "@aiden0z/pptx-renderer";
import type {
  PresentationPreviewDocument,
  PresentationPreviewEngine,
  PresentationPageElement,
  PresentationRenderHandle,
  PresentationRenderOptions,
} from "@/presentation/types.js";
import { buildPresentationPageElements } from "@/presentation/presentationElementModel.js";

interface TextBodyLike {
  paragraphs: Array<{ runs: Array<{ text: string }> }>;
}

interface SlideNodeLike {
  id: string;
  name: string;
  nodeType: "shape" | "picture" | "table" | "group" | "chart" | "unknown";
  position: { x: number; y: number };
  size: { w: number; h: number };
  textBody?: TextBodyLike;
  columns?: number[];
  rows?: Array<{
    height: number;
    cells: Array<{
      gridSpan: number;
      rowSpan: number;
      hMerge: boolean;
      vMerge: boolean;
      textBody?: TextBodyLike;
    }>;
  }>;
}

interface PresentationLike {
  width: number;
  height: number;
  slides: Array<{
    slidePath: string;
    nodes: SlideNodeLike[];
  }>;
}

interface TextIndexEntryLike {
  slideIndex: number;
  nodeId: string;
  nodePath: string;
  textKind: "shape" | "table-cell";
  text: string;
  bounds: { x: number; y: number; w: number; h: number };
}

function readTextBody(textBody: TextBodyLike | undefined) {
  return textBody?.paragraphs
    .map((paragraph) => paragraph.runs.map((run) => run.text).join(""))
    .join("\n")
    .trim();
}

class PptxRendererPreviewDocument implements PresentationPreviewDocument {
  readonly pageCount: number;
  readonly pageSize: { width: number; height: number };

  private readonly activeHandles = new Set<PresentationRenderHandle>();
  private readonly elementCache = new Map<number, readonly PresentationPageElement[]>();
  private disposed = false;

  constructor(private readonly presentation: PresentationLike) {
    this.pageCount = presentation.slides.length;
    this.pageSize = {
      width: presentation.width,
      height: presentation.height,
    };
  }

  getPageElements(pageIndex: number) {
    if (this.disposed) {
      throw new Error("Presentation preview document has been disposed");
    }
    const cached = this.elementCache.get(pageIndex);
    if (cached) {
      return cached;
    }
    const slide = this.presentation.slides[pageIndex];
    if (!slide) {
      throw new RangeError(`Presentation page index is out of range: ${pageIndex}`);
    }
    // [evoflow-vendor] 同 renderSlide/buildTextIndex：宽松视图断言回严格参数类型。
    materializeSlideNodes(
      this.presentation as Parameters<typeof materializeSlideNodes>[0],
      slide as Parameters<typeof materializeSlideNodes>[1],
    );
    // 只为当前页建立 group 文本索引，避免显式选择一页时提前 materialize 整份演示文稿。
    // [evoflow-vendor] 本引擎持有宽松的 PresentationLike 视图；运行时对象来自
    // buildPresentation() 产出的完整 PresentationData，边界处断言回严格类型。
    const groupTextIndex = buildTextIndex(
      { ...this.presentation, slides: [slide] } as Parameters<typeof buildTextIndex>[0],
      {
        includeGroups: true,
        includeShapes: true,
        includeTables: false,
      },
    ) as TextIndexEntryLike[];
    const directNodeIds = new Set(slide.nodes.map((node) => node.id));
    const elements = buildPresentationPageElements({
      slideIndex: pageIndex,
      slidePart: slide.slidePath,
      nodes: slide.nodes.map((node) => ({
        id: node.id,
        name: node.name,
        nodeType: node.nodeType,
        position: node.position,
        size: node.size,
        ...(node.nodeType === "shape" ? { text: readTextBody(node.textBody) } : {}),
        ...(node.nodeType === "table"
          ? {
              columns: node.columns ?? [],
              rows: (node.rows ?? []).map((row) => ({
                height: row.height,
                cells: row.cells.map((cell) => ({
                  gridSpan: cell.gridSpan,
                  rowSpan: cell.rowSpan,
                  hMerge: cell.hMerge,
                  vMerge: cell.vMerge,
                  text: readTextBody(cell.textBody),
                })),
              })),
            }
          : {}),
      })),
      groupTextEntries: groupTextIndex
        .filter(
          (entry) =>
            entry.slideIndex === 0 &&
            entry.textKind === "shape" &&
            entry.nodePath.startsWith("slides/0/nodes/") &&
            !directNodeIds.has(entry.nodeId),
        )
        .map((entry) => ({
          nodeId: entry.nodeId,
          nodePath: entry.nodePath,
          text: entry.text,
          bounds: entry.bounds,
        })),
    });
    this.elementCache.set(pageIndex, elements);
    return elements;
  }

  renderPage(
    pageIndex: number,
    container: HTMLElement,
    options?: PresentationRenderOptions,
  ): PresentationRenderHandle {
    if (this.disposed) {
      throw new Error("Presentation preview document has been disposed");
    }

    const slide = this.presentation.slides[pageIndex];
    if (!slide) {
      throw new RangeError(`Presentation page index is out of range: ${pageIndex}`);
    }

    // [evoflow-vendor] 同上：PresentationLike → renderSlide 的严格参数类型断言。
    const upstreamHandle: SlideHandle = renderSlide(
      this.presentation as Parameters<typeof renderSlide>[0],
      slide as Parameters<typeof renderSlide>[1],
      {
      onNavigate: options?.onNavigate
        ? (target: { slideIndex?: number; url?: string }) =>
            options.onNavigate?.({
              pageIndex: target.slideIndex,
              url: target.url,
            })
        : undefined,
      onNodeError: options?.onNodeError,
    });
    container.append(upstreamHandle.element);

    let handleDisposed = false;
    const handle: PresentationRenderHandle = {
      ready: upstreamHandle.ready,
      dispose: () => {
        if (handleDisposed) {
          return;
        }
        handleDisposed = true;
        upstreamHandle.dispose();
        upstreamHandle.element.remove();
        this.activeHandles.delete(handle);
      },
    };
    this.activeHandles.add(handle);
    return handle;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const handle of this.activeHandles) {
      handle.dispose();
    }
    this.activeHandles.clear();
    this.elementCache.clear();
  }
}

export const pptxRendererPreviewEngine: PresentationPreviewEngine = {
  async open(data) {
    const files = await parseZipLazyMedia(data, RECOMMENDED_ZIP_LIMITS);
    const presentation = buildPresentation(files, { lazySlides: true });
    return new PptxRendererPreviewDocument(presentation);
  },
};
