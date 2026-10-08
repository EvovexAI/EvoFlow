import { useEffect, useRef } from "react";
import { createOnboardingMeshRenderer } from "@/onboarding/onboardingMeshRenderer.js";
import { useResolvedThemeHeroPalette } from "@/openWorkspacePageThemeHero.js";

/** 装饰背景拥有自己的渲染生命周期，不订阅或修改业务状态。 */
export function OnboardingMeshBackground() {
  const ref = useRef<HTMLCanvasElement>(null);
  const { meshBase, meshLight } = useResolvedThemeHeroPalette();
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const color = [1, 3, 5].map(
      (offset) => parseInt(meshLight.slice(offset, offset + 2), 16) / 255,
    ) as [number, number, number];
    let renderer: ReturnType<typeof createOnboardingMeshRenderer> = null;
    let frame = 0;
    let last = 0;
    let elapsed = 0;
    let visible = false;
    let lost = false;
    let disposed = false;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const desktop = window.matchMedia("(min-width: 1024px)");
    const tick = (now: number) => {
      frame = 0;
      if (disposed || lost || !visible || document.hidden || !desktop.matches) return;
      const { width, height } = canvas.getBoundingClientRect();
      if (!width || !height) return;
      // 首次真正可见时才创建上下文，手机单栏不占用 GPU。
      renderer ??= createOnboardingMeshRenderer(canvas);
      if (!renderer) return;
      if (!last || now - last >= 1000 / 24) {
        if (last && !reduced.matches) elapsed += Math.min((now - last) / 1000, 0.1);
        last = now;
        renderer.draw(elapsed, width, height, color);
        canvas.style.opacity = "1";
      }
      if (!reduced.matches) frame = requestAnimationFrame(tick);
    };
    const restart = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      last = 0;
      if (!disposed) tick(performance.now());
    };
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? false;
      restart();
    });
    const resize = new ResizeObserver(restart);
    const contextLost = (event: Event) => {
      event.preventDefault();
      lost = true;
      cancelAnimationFrame(frame);
      canvas.style.opacity = "0";
    };
    const contextRestored = () => {
      renderer?.dispose();
      renderer = null;
      lost = false;
      restart();
    };
    observer.observe(canvas);
    resize.observe(canvas);
    reduced.addEventListener("change", restart);
    desktop.addEventListener("change", restart);
    document.addEventListener("visibilitychange", restart);
    canvas.addEventListener("webglcontextlost", contextLost);
    canvas.addEventListener("webglcontextrestored", contextRestored);
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      resize.disconnect();
      reduced.removeEventListener("change", restart);
      desktop.removeEventListener("change", restart);
      document.removeEventListener("visibilitychange", restart);
      canvas.removeEventListener("webglcontextlost", contextLost);
      canvas.removeEventListener("webglcontextrestored", contextRestored);
      renderer?.dispose();
    };
  }, [meshLight]);
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 overflow-hidden rounded-[inherit]"
      style={{ backgroundColor: meshBase }}
    >
      <canvas
        ref={ref}
        data-testid="onboarding-mesh-background"
        className="absolute inset-0 h-full w-full opacity-0"
      />
    </div>
  );
}
