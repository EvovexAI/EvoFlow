// 分屏布局计算（纯函数）：分割树 → 每个叶子/分隔条的绝对定位表达式。
// 叶子扁平渲染为容器直接子元素（key = paneId 稳定）——拆分/关闭只是换 rect，
// React 不重挂任何存活 pane（virtualizer 测高、滚动位置、composer 草稿全保留）；
// 若按树递归嵌套渲染，叶子被替换成分割容器时会整棵重挂。
// rect 表达式引用分割占比 CSS 变量：拖动中改一个变量，受影响的 pane/分隔条全部
// 由 CSS 重排，零 React 渲染（「容器 CSS 变量」方案按分割节点泛化）。
import type { CSSProperties } from "react";
import type { PaneLayoutNode, SplitDirection } from "@/v4/paneLayoutTree.js";

/** 分割占比 CSS 变量前缀（每个分割节点一个 `--v4-split-<nodeId>`）。 */
export const SPLIT_VAR_PREFIX = "--v4-split-";

/** 绝对定位表达式（不含 calc() 包裹；style 侧统一 `calc(${expr})`）。 */
export interface RectExpr {
  left: string;
  top: string;
  width: string;
  height: string;
}

interface LeafLayout {
  paneId: string;
  rect: RectExpr;
}

interface DividerLayout {
  splitId: string;
  direction: SplitDirection;
  /** store 当前占比（拖拽起点 + 容器 CSS 变量初值）。 */
  ratio: number;
  /** 该分割节点区域占容器主轴的数值比例（拖拽像素→占比换算；祖先占比取 store 数值）。 */
  regionFraction: number;
  /** 分割线（主轴位置）表达式。 */
  boundary: string;
  /** 交叉轴起点/长度表达式。 */
  crossStart: string;
  crossLength: string;
}

const ROOT_RECT: RectExpr = {
  left: "0%",
  top: "0%",
  width: "100%",
  height: "100%",
};

function collectNode(
  node: PaneLayoutNode,
  rect: RectExpr,
  widthFraction: number,
  heightFraction: number,
  leaves: LeafLayout[],
  dividers: DividerLayout[],
): void {
  if (node.type === "leaf") {
    leaves.push({ paneId: node.paneId, rect });
    return;
  }
  const ratioVar = `var(${SPLIT_VAR_PREFIX}${node.id}, ${node.ratio})`;
  if (node.direction === "row") {
    const boundary = `(${rect.left}) + (${rect.width}) * ${ratioVar}`;
    dividers.push({
      splitId: node.id,
      direction: "row",
      ratio: node.ratio,
      regionFraction: widthFraction,
      boundary,
      crossStart: rect.top,
      crossLength: rect.height,
    });
    collectNode(
      node.first,
      { ...rect, width: `(${rect.width}) * ${ratioVar}` },
      widthFraction * node.ratio,
      heightFraction,
      leaves,
      dividers,
    );
    collectNode(
      node.second,
      { ...rect, left: boundary, width: `(${rect.width}) * (1 - ${ratioVar})` },
      widthFraction * (1 - node.ratio),
      heightFraction,
      leaves,
      dividers,
    );
    return;
  }
  const boundary = `(${rect.top}) + (${rect.height}) * ${ratioVar}`;
  dividers.push({
    splitId: node.id,
    direction: "column",
    ratio: node.ratio,
    regionFraction: heightFraction,
    boundary,
    crossStart: rect.left,
    crossLength: rect.width,
  });
  collectNode(
    node.first,
    { ...rect, height: `(${rect.height}) * ${ratioVar}` },
    widthFraction,
    heightFraction * node.ratio,
    leaves,
    dividers,
  );
  collectNode(
    node.second,
    { ...rect, top: boundary, height: `(${rect.height}) * (1 - ${ratioVar})` },
    widthFraction,
    heightFraction * (1 - node.ratio),
    leaves,
    dividers,
  );
}

interface WorkbenchLayout {
  leaves: LeafLayout[];
  dividers: DividerLayout[];
}

export function collectWorkbenchLayout(root: PaneLayoutNode): WorkbenchLayout {
  const leaves: LeafLayout[] = [];
  const dividers: DividerLayout[] = [];
  collectNode(root, ROOT_RECT, 1, 1, leaves, dividers);
  return { leaves, dividers };
}

export function rectStyle(rect: RectExpr): CSSProperties {
  return {
    left: `calc(${rect.left})`,
    top: `calc(${rect.top})`,
    width: `calc(${rect.width})`,
    height: `calc(${rect.height})`,
  };
}

export function dividerStyle(divider: DividerLayout): CSSProperties {
  if (divider.direction === "row") {
    return {
      left: `calc(${divider.boundary})`,
      top: `calc(${divider.crossStart})`,
      height: `calc(${divider.crossLength})`,
      width: "9px",
      transform: "translateX(-50%)",
    };
  }
  return {
    top: `calc(${divider.boundary})`,
    left: `calc(${divider.crossStart})`,
    width: `calc(${divider.crossLength})`,
    height: "9px",
    transform: "translateY(-50%)",
  };
}
