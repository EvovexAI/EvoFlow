export function resolveUpdateButtonResponsiveClasses({
  isMacDesktop,
  isWindowsDesktop,
}: {
  isMacDesktop: boolean;
  isWindowsDesktop: boolean;
}) {
  // Tailwind 只能收集源码里出现的完整类名。
  // 之前把容器查询前缀拼成 `${responsiveExpandClass}:...` 后，
  // Windows 分支对应的 `@min-[200px]/topoverlayer:*` 根本不会进最终 CSS，
  // 表现出来就是平台判断“看起来没生效”。
  if (isMacDesktop) {
    return {
      expandWidthClass: "@min-[280px]/topoverlayer:w-auto",
      hideIconClass: "@min-[280px]/topoverlayer:hidden",
      revealTextClass: [
        "@min-[280px]/topoverlayer:opacity-100",
        "@min-[280px]/topoverlayer:w-auto",
        "@min-[280px]/topoverlayer:relative",
      ],
    };
  }

  if (isWindowsDesktop) {
    return {
      expandWidthClass: "@min-[216px]/topoverlayer:w-auto",
      hideIconClass: "@min-[216px]/topoverlayer:hidden",
      revealTextClass: [
        "@min-[216px]/topoverlayer:opacity-100",
        "@min-[216px]/topoverlayer:w-auto",
        "@min-[216px]/topoverlayer:relative",
      ],
    };
  }

  return {
    expandWidthClass: "@min-[280px]/topoverlayer:w-auto",
    hideIconClass: "@min-[280px]/topoverlayer:hidden",
    revealTextClass: [
      "@min-[280px]/topoverlayer:opacity-100",
      "@min-[280px]/topoverlayer:w-auto",
      "@min-[280px]/topoverlayer:relative",
    ],
  };
}
