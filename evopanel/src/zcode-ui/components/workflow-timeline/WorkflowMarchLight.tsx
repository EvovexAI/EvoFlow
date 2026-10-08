/**
 * 行进边的光：控制流进入正在运行的站所走的那条边，
 * 在 SVG 里叠一条 1.5px、圆头的路径，用一道 `userSpaceOnUse` 的渐变描边——从路径起点的全透明到 80% 处的
 * 满警示色，于是它在灯那一头最亮、朝控制流来的方向淡去，像是灯照亮了自己来的路。它不动：行进边说的是
 * 过去（控制流走了这条边），动作属于正在运行的灯（`wf-lamp-running` 的搏动）。之前是一条沿路径滚动的
 * 警示色虚线，读起来像「还在从上一站往这一站赶路」。
 *
 * 渐变沿 x 铺（路径首尾两点的 x）；时间线的弧、分叉与汇合曲线除了两截短竖段都是横的，这就够了。
 * 首尾 x 相同的路径（脊线里没有，但守一下）改沿 y 铺。`id` 由调用方给，同一张 SVG 里要唯一。
 */
export interface MarchLightProps {
  /** 要点亮的路径；弧给的是截短 6px、停在箭头根部的那条。 */
  d: string;
  /** 路径起点（控制流来的那一头）。 */
  from: { x: number; y: number };
  /** 路径终点（正在运行的灯那一头）。 */
  to: { x: number; y: number };
  id: string;
}

export function MarchLight({ d, from, id, to }: MarchLightProps) {
  const alongY = from.x === to.x;
  return (
    <>
      <defs>
        <linearGradient
          gradientUnits="userSpaceOnUse"
          id={id}
          x1={alongY ? 0 : from.x}
          x2={alongY ? 0 : to.x}
          y1={alongY ? from.y : 0}
          y2={alongY ? to.y : 0}
        >
          <stop offset={0} stopColor="var(--color-warning)" stopOpacity={0} />
          <stop offset={0.8} stopColor="var(--color-warning)" />
        </linearGradient>
      </defs>
      <path
        className="wf-lit"
        d={d}
        data-testid="workflow-march-light"
        fill="none"
        stroke={`url(#${id})`}
      />
    </>
  );
}
