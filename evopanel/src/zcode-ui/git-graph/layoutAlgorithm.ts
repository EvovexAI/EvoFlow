import type { GitCommitGraphCommit } from "@zcode/shared";

export interface GraphPoint {
  laneIndex: number;
  rowIndex: number;
}

export interface BranchLineSeed {
  from: GraphPoint;
  to: GraphPoint;
  laneIndex: number;
  sourceHash: string;
  targetHash: string;
  lockedFirst: boolean;
}

interface LaneConnection {
  target: LayoutVertex;
  branch: LayoutBranch;
}

const MISSING_PARENT_ID = -1;

class LayoutBranch {
  readonly colourIndex: number;
  readonly lines: BranchLineSeed[] = [];
  endRowIndex = 0;

  constructor(colourIndex: number) {
    this.colourIndex = colourIndex;
  }

  addLine(
    from: GraphPoint,
    to: GraphPoint,
    sourceHash: string,
    targetHash: string,
    lockedFirst: boolean,
  ) {
    this.lines.push({ from, to, laneIndex: this.colourIndex, sourceHash, targetHash, lockedFirst });
  }
}

class LayoutVertex {
  readonly id: number;
  readonly hash: string;
  private readonly parents: LayoutVertex[] = [];
  private nextParentIndex = 0;
  private laneIndex: number | null = null;
  private branch: LayoutBranch | null = null;
  private nextLaneIndex = 0;
  private readonly connections: Array<LaneConnection | undefined> = [];

  constructor(id: number, hash: string) {
    this.id = id;
    this.hash = hash;
  }

  addParent(vertex: LayoutVertex) {
    this.parents.push(vertex);
  }

  getNextParent() {
    return this.nextParentIndex < this.parents.length ? this.parents[this.nextParentIndex]! : null;
  }

  registerParentProcessed() {
    this.nextParentIndex++;
  }

  isMerge() {
    return this.parents.length > 1;
  }

  isNotOnBranch() {
    return this.branch === null || this.laneIndex === null;
  }

  addToBranch(branch: LayoutBranch, laneIndex: number) {
    if (this.branch === null) {
      this.branch = branch;
      this.laneIndex = laneIndex;
    }
  }

  getBranch() {
    return this.branch;
  }

  getLaneIndex() {
    return this.laneIndex ?? 0;
  }

  getPoint(): GraphPoint {
    return { laneIndex: this.getLaneIndex(), rowIndex: this.id };
  }

  getNextPoint(): GraphPoint {
    return { laneIndex: this.nextLaneIndex, rowIndex: this.id };
  }

  getPointConnectingTo(target: LayoutVertex, branch: LayoutBranch) {
    const connectionIndex = this.connections.findIndex(
      (connection) => connection?.target === target && connection.branch === branch,
    );

    return connectionIndex >= 0 ? { laneIndex: connectionIndex, rowIndex: this.id } : null;
  }

  reservePoint(laneIndex: number, target: LayoutVertex, branch: LayoutBranch) {
    if (laneIndex === this.nextLaneIndex) {
      this.connections[laneIndex] = { target, branch };
      this.nextLaneIndex = laneIndex + 1;
    }
  }

  getWidthLaneIndex() {
    return this.nextLaneIndex;
  }
}

function createVertices(commits: readonly GitCommitGraphCommit[]) {
  const missingParent = new LayoutVertex(MISSING_PARENT_ID, "__zcode_missing_parent__");
  const vertices = commits.map((commit, index) => new LayoutVertex(index, commit.hash));
  const vertexByHash = new Map(vertices.map((vertex) => [vertex.hash, vertex]));

  for (const [index, commit] of commits.entries()) {
    const vertex = vertices[index]!;
    for (const parentHash of commit.parents) {
      const parent = vertexByHash.get(parentHash) ?? missingParent;
      vertex.addParent(parent);
    }
  }

  return { missingParent, vertices, vertexByHash };
}

function getAvailableColour(startAt: number, availableColours: number[]) {
  const reusableColour = availableColours.findIndex((endAt) => startAt > endAt);
  if (reusableColour >= 0) return reusableColour;
  availableColours.push(0);
  return availableColours.length - 1;
}

function determineMergePath(
  startAt: number,
  vertices: LayoutVertex[],
  vertex: LayoutVertex,
  parentVertex: LayoutVertex,
) {
  const parentBranch = parentVertex.getBranch()!;
  let lastPoint = vertex.getPoint();
  let foundConnectionToParent = false;

  for (let rowIndex = startAt + 1; rowIndex < vertices.length; rowIndex++) {
    const currentVertex = vertices[rowIndex]!;
    const existingPoint = currentVertex.getPointConnectingTo(parentVertex, parentBranch);
    const currentPoint = existingPoint ?? currentVertex.getNextPoint();
    foundConnectionToParent = existingPoint !== null;
    parentBranch.addLine(
      lastPoint,
      currentPoint,
      vertex.hash,
      parentVertex.hash,
      !foundConnectionToParent && currentVertex !== parentVertex
        ? lastPoint.laneIndex < currentPoint.laneIndex
        : true,
    );
    currentVertex.reservePoint(currentPoint.laneIndex, parentVertex, parentBranch);
    lastPoint = currentPoint;
    if (foundConnectionToParent) {
      vertex.registerParentProcessed();
      break;
    }
  }
}

function determineNormalPath(params: {
  startAt: number;
  vertices: LayoutVertex[];
  branches: LayoutBranch[];
  availableColours: number[];
  missingParent: LayoutVertex;
}) {
  const { startAt, vertices, branches, availableColours, missingParent } = params;
  let rowIndex = startAt;
  let vertex = vertices[rowIndex]!;
  let parentVertex = vertex.getNextParent();
  let lastPoint = vertex.isNotOnBranch() ? vertex.getNextPoint() : vertex.getPoint();
  const branch = new LayoutBranch(getAvailableColour(startAt, availableColours));
  vertex.addToBranch(branch, lastPoint.laneIndex);
  vertex.reservePoint(lastPoint.laneIndex, vertex, branch);

  for (rowIndex = startAt + 1; rowIndex < vertices.length; rowIndex++) {
    if (parentVertex === null || parentVertex === missingParent) break;
    const currentVertex = vertices[rowIndex]!;
    const currentPoint =
      parentVertex === currentVertex && !parentVertex.isNotOnBranch()
        ? currentVertex.getPoint()
        : currentVertex.getNextPoint();
    branch.addLine(
      lastPoint,
      currentPoint,
      vertex.hash,
      parentVertex.hash,
      lastPoint.laneIndex < currentPoint.laneIndex,
    );
    currentVertex.reservePoint(currentPoint.laneIndex, parentVertex, branch);
    lastPoint = currentPoint;
    if (parentVertex === currentVertex) {
      vertex.registerParentProcessed();
      const parentWasAlreadyOnBranch = !parentVertex.isNotOnBranch();
      parentVertex.addToBranch(branch, currentPoint.laneIndex);
      vertex = parentVertex;
      parentVertex = vertex.getNextParent();
      if (parentVertex === missingParent) {
        // 分页窗口外的 parent 没有可见节点，不能继续把线画到窗口底部。
        vertex.registerParentProcessed();
        break;
      }
      if (parentVertex === null || parentWasAlreadyOnBranch) break;
    }
  }

  branch.endRowIndex = rowIndex;
  branches.push(branch);
  availableColours[branch.colourIndex] = rowIndex;
}

function determinePath(params: {
  startAt: number;
  vertices: LayoutVertex[];
  branches: LayoutBranch[];
  availableColours: number[];
  missingParent: LayoutVertex;
}) {
  const vertex = params.vertices[params.startAt]!;
  const parentVertex = vertex.getNextParent();
  if (parentVertex === params.missingParent) {
    vertex.registerParentProcessed();
    return;
  }

  if (
    parentVertex !== null &&
    vertex.isMerge() &&
    !vertex.isNotOnBranch() &&
    !parentVertex.isNotOnBranch()
  ) {
    determineMergePath(params.startAt, params.vertices, vertex, parentVertex);
    return;
  }

  determineNormalPath(params);
}

export function createGitGraphLayoutModel(commits: readonly GitCommitGraphCommit[]) {
  const { missingParent, vertices, vertexByHash } = createVertices(commits);
  const branches: LayoutBranch[] = [];
  const availableColours: number[] = [];
  let index = 0;

  while (index < vertices.length) {
    const vertex = vertices[index]!;
    if (vertex.getNextParent() !== null || vertex.isNotOnBranch()) {
      determinePath({ startAt: index, vertices, branches, availableColours, missingParent });
    } else {
      index++;
    }
  }

  return {
    vertices,
    vertexByHash,
    branchLines: branches.flatMap((branch) => branch.lines),
  };
}
