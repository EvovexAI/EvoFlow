import { Collapsible as CollapsiblePrimitive } from "radix-ui";
import { cn } from "../lib/utils.js";

function Collapsible({ ...props }: React.ComponentProps<typeof CollapsiblePrimitive.Root>) {
  return <CollapsiblePrimitive.Root data-slot="collapsible" {...props} />;
}

function CollapsibleTrigger({
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.CollapsibleTrigger>) {
  return <CollapsiblePrimitive.CollapsibleTrigger data-slot="collapsible-trigger" {...props} />;
}

function CollapsibleContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.CollapsibleContent>) {
  return (
    <CollapsiblePrimitive.CollapsibleContent
      data-slot="collapsible-content"
      className={cn(
        "group/collapsible-content overflow-hidden",
        "data-[state=open]:animate-collapsible-down data-[state=closed]:animate-collapsible-up data-[state=closed]:[animation-fill-mode:forwards] transition-none duration-300 ease-in-out",
        className,
      )}
      {...props}
    >
      <div
        className={cn(
          "transition-none duration-300 ease-in-out",
          "group-data-[state=open]/collapsible-content:animate-in group-data-[state=open]/collapsible-content:fade-in-0",
          "group-data-[state=closed]/collapsible-content:animate-out group-data-[state=closed]/collapsible-content:fade-out-0 group-data-[state=closed]/collapsible-content:[animation-fill-mode:forwards]",
        )}
      >
        {/* 大会话 resize trace 显示 collapsible 动画层只设置 duration/ease 时，
            浏览器会用默认 transition-property: all 动画 scrollbar-color，拖拽窗口时触发非合成动画。
            这里显式禁用 CSS transition，只保留 animate-in/out 的关键帧动画。 */}
        {/* tw-animate-css 并没有 animate-fade-in / animate-fade-out 这类工具类，
            必须用 animate-in/out 搭配 fade-in-0 / fade-out-0。
            同时子层 div 本身没有 data-state，所以这里继续读取父层 content 的 state，
            让透明度动画和高度动画稳定分层。
            打开时再补一个轻微 delay，避免内容还被 0 高度裁切时就把淡入过程提前消耗掉。 */}
        {children}
      </div>
    </CollapsiblePrimitive.CollapsibleContent>
  );
}

export { Collapsible, CollapsibleTrigger, CollapsibleContent };
