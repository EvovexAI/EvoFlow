export interface PresentationPageSize {
  width: number;
  height: number;
}

export interface PresentationRenderOptions {
  onNavigate?: (target: { pageIndex?: number; url?: string }) => void;
  onNodeError?: (nodeId: string, error: unknown) => void;
}

export interface PresentationRenderHandle {
  readonly ready: Promise<void>;
  dispose(): void;
}

export type PresentationElementNodeType = "shape" | "picture" | "chart" | "table" | "table-cell";

export interface PresentationElementBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PresentationPageElement {
  slideIndex: number;
  slidePart: string;
  nodeId: string;
  nodePath?: string;
  nodeName: string;
  nodeType: PresentationElementNodeType;
  text?: string;
  bounds: PresentationElementBounds;
  zIndex: number;
  rowIndex?: number;
  cellIndex?: number;
}

export interface PresentationPreviewDocument {
  readonly pageCount: number;
  readonly pageSize: PresentationPageSize;
  getPageElements(pageIndex: number): readonly PresentationPageElement[];
  renderPage(
    pageIndex: number,
    container: HTMLElement,
    options?: PresentationRenderOptions,
  ): PresentationRenderHandle;
  dispose(): void;
}

export interface PresentationPreviewEngine {
  open(data: ArrayBuffer): Promise<PresentationPreviewDocument>;
}
