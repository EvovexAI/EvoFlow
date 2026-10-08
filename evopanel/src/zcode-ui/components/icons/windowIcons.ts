import { createLucideIcon } from "lucide-react";

// 用户提供的窗口图形使用 Lucide 渲染，去掉白底并继承主题前景色及全局线宽。
export const WindowMaximizeIcon = createLucideIcon("WindowMaximize", [
  [
    "path",
    {
      d: "M17.4444 5H6.55556C5.69645 5 5 5.69645 5 6.55556V17.4444C5 18.3036 5.69645 19 6.55556 19H17.4444C18.3036 19 19 18.3036 19 17.4444V6.55556C19 5.69645 18.3036 5 17.4444 5Z",
      key: "frame",
    },
  ],
]);

export const WindowRestoreIcon = createLucideIcon("WindowRestore", [
  ["path", { d: "M9 5H13C16.3137 5 19 7.68629 19 11V15", key: "back" }],
  ["rect", { x: "5", y: "9", width: "10", height: "10", rx: "2", key: "front" }],
]);
