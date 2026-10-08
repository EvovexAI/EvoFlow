import type { GitCommitGraphCommit, GitCommitGraphRef, GitCommitGraphRefKind } from "@zcode/shared";
import {
  createGitGraphLayoutModel,
  type BranchLineSeed,
  type GraphPoint,
} from "@/git-graph/layoutAlgorithm.js";

export type GitGraphRefKind = GitCommitGraphRefKind;
export type GitGraphRef = GitCommitGraphRef;
export type GitGraphCommit = GitCommitGraphCommit;

export interface GitGraphLayoutOptions {
  rowHeight?: number;
  laneGap?: number;
  lanePadding?: number;
  topPadding?: number;
  bottomPadding?: number;
}

export interface GitGraphLayoutRow {
  commit: GitGraphCommit;
  rowIndex: number;
  laneIndex: number;
  x: number;
  y: number;
}

export interface GitGraphLayoutEdge {
  id: string;
  fromHash: string;
  toHash: string;
  fromLaneIndex: number;
  toLaneIndex: number;
  path: string;
  truncated: boolean;
}

interface GitGraphLayoutLaneSegment {
  id: string;
  hash: string;
  laneIndex: number;
  path: string;
}

export interface GitGraphLayoutPath {
  id: string;
  laneIndex: number;
  path: string;
  relatedHashes: string[];
}

export interface GitGraphLayout {
  rows: GitGraphLayoutRow[];
  edges: GitGraphLayoutEdge[];
  laneSegments: GitGraphLayoutLaneSegment[];
  paths: GitGraphLayoutPath[];
  laneCount: number;
  width: number;
  height: number;
  rowHeight: number;
  laneGap: number;
}

interface PixelOptions {
  lanePadding: number;
  laneGap: number;
  topPadding: number;
  rowHeight: number;
}

const DEFAULT_ROW_HEIGHT = 42;
const DEFAULT_LANE_GAP = 18;
const DEFAULT_LANE_PADDING = 16;
const DEFAULT_TOP_PADDING = 20;
const DEFAULT_BOTTOM_PADDING = 18;

function buildEdgePath({
  fromX,
  fromY,
  toX,
  toY,
  lockedFirst,
}: {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  lockedFirst?: boolean;
}): string {
  if (fromX === toX) {
    return `M ${fromX} ${fromY} L ${toX} ${toY}`;
  }

  const curveOffset = Math.max(14, Math.abs(toY - fromY) * 0.38);
  if (lockedFirst === false) {
    return [
      `M ${fromX} ${fromY}`,
      `C ${fromX} ${toY - curveOffset}, ${toX} ${toY - curveOffset}, ${toX} ${toY}`,
    ].join(" ");
  }

  return [
    `M ${fromX} ${fromY}`,
    `C ${fromX} ${fromY + curveOffset}, ${toX} ${fromY + curveOffset}, ${toX} ${toY}`,
  ].join(" ");
}

function pointToPixels(point: GraphPoint, options: PixelOptions) {
  return {
    x: options.lanePadding + point.laneIndex * options.laneGap,
    y: options.topPadding + point.rowIndex * options.rowHeight,
  };
}

function createGraphPath(
  line: BranchLineSeed,
  lineIndex: number,
  pixelOptions: PixelOptions,
): GitGraphLayoutPath {
  const from = pointToPixels(line.from, pixelOptions);
  const to = pointToPixels(line.to, pixelOptions);

  return {
    id: `${line.sourceHash}:${line.targetHash}:${line.from.rowIndex}:${line.to.rowIndex}:${lineIndex}:path`,
    laneIndex: line.laneIndex,
    path: buildEdgePath({
      fromX: from.x,
      fromY: from.y,
      toX: to.x,
      toY: to.y,
      lockedFirst: line.lockedFirst,
    }),
    relatedHashes:
      line.sourceHash === line.targetHash ? [line.sourceHash] : [line.sourceHash, line.targetHash],
  };
}

function createLaneSegment(
  line: BranchLineSeed,
  lineIndex: number,
  pixelOptions: PixelOptions,
): GitGraphLayoutLaneSegment {
  const from = pointToPixels(line.from, pixelOptions);
  const to = pointToPixels(line.to, pixelOptions);

  return {
    id: `${line.sourceHash}:${line.targetHash}:${line.from.rowIndex}:${line.to.rowIndex}:${lineIndex}:segment`,
    hash: line.targetHash,
    laneIndex: line.to.laneIndex,
    path: buildEdgePath({
      fromX: from.x,
      fromY: from.y,
      toX: to.x,
      toY: to.y,
      lockedFirst: line.lockedFirst,
    }),
  };
}

function createEdges(params: {
  commits: readonly GitGraphCommit[];
  rows: GitGraphLayoutRow[];
  vertexByHash: ReturnType<typeof createGitGraphLayoutModel>["vertexByHash"];
  rowByHash: Map<string, GitGraphLayoutRow>;
  pixelOptions: PixelOptions;
}): GitGraphLayoutEdge[] {
  const { commits, rows, vertexByHash, rowByHash, pixelOptions } = params;

  return commits.flatMap((commit, rowIndex): GitGraphLayoutEdge[] => {
    const fromVertex = vertexByHash.get(commit.hash)!;
    return commit.parents.map((parentHash, parentIndex): GitGraphLayoutEdge => {
      const parentVertex = vertexByHash.get(parentHash) ?? null;
      const fromLaneIndex = fromVertex.getLaneIndex();
      const toLaneIndex = parentVertex ? parentVertex.getLaneIndex() : fromLaneIndex + parentIndex;
      const fromRow = rows[rowIndex]!;
      const toRow = rowByHash.get(parentHash);
      const fromX = pixelOptions.lanePadding + fromLaneIndex * pixelOptions.laneGap;
      const toX = pixelOptions.lanePadding + toLaneIndex * pixelOptions.laneGap;

      return {
        id: `${commit.hash}:${parentHash}:${parentIndex}`,
        fromHash: commit.hash,
        toHash: parentHash,
        fromLaneIndex,
        toLaneIndex,
        path: buildEdgePath({
          fromX,
          fromY: fromRow.y,
          toX,
          toY: toRow?.y ?? fromRow.y,
          lockedFirst: fromLaneIndex < toLaneIndex,
        }),
        truncated: !toRow,
      };
    });
  });
}

export function layoutGitGraph(
  commits: readonly GitGraphCommit[],
  options: GitGraphLayoutOptions = {},
): GitGraphLayout {
  const rowHeight = options.rowHeight ?? DEFAULT_ROW_HEIGHT;
  const laneGap = options.laneGap ?? DEFAULT_LANE_GAP;
  const lanePadding = options.lanePadding ?? DEFAULT_LANE_PADDING;
  const topPadding = options.topPadding ?? DEFAULT_TOP_PADDING;
  const bottomPadding = options.bottomPadding ?? DEFAULT_BOTTOM_PADDING;
  const { vertices, vertexByHash, branchLines } = createGitGraphLayoutModel(commits);

  const rows = vertices.map((vertex, rowIndex): GitGraphLayoutRow => {
    const laneIndex = vertex.getLaneIndex();

    return {
      commit: commits[rowIndex]!,
      rowIndex,
      laneIndex,
      x: lanePadding + laneIndex * laneGap,
      y: topPadding + rowIndex * rowHeight,
    };
  });
  const rowByHash = new Map(rows.map((row) => [row.commit.hash, row]));
  const maxRowLaneIndex = rows.reduce((max, row) => Math.max(max, row.laneIndex), 0);
  const maxWidthLaneIndex = vertices.reduce(
    (max, vertex) => Math.max(max, vertex.getWidthLaneIndex() - 1),
    0,
  );
  const maxLineLaneIndex = branchLines.reduce(
    (max, line) => Math.max(max, line.from.laneIndex, line.to.laneIndex),
    0,
  );
  const laneCount = Math.max(1, maxRowLaneIndex + 1, maxWidthLaneIndex + 1, maxLineLaneIndex + 1);
  const height = topPadding + Math.max(0, commits.length - 1) * rowHeight + bottomPadding;
  const width = lanePadding * 2 + (laneCount - 1) * laneGap;
  const pixelOptions = { lanePadding, laneGap, topPadding, rowHeight };
  const verticalLines = branchLines.filter((line) => line.from.laneIndex === line.to.laneIndex);

  return {
    rows,
    edges: createEdges({ commits, rows, vertexByHash, rowByHash, pixelOptions }),
    laneSegments: verticalLines.map((line, index) => createLaneSegment(line, index, pixelOptions)),
    paths: branchLines.map((line, index) => createGraphPath(line, index, pixelOptions)),
    laneCount,
    width,
    height,
    rowHeight,
    laneGap,
  };
}
