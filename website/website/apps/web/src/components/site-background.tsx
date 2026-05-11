"use client";

import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import { useIsMobile } from "@/hooks/use-is-mobile";

/**
 * 动态背景（粒子场 / 星座连线 / 漂浮光晕）开销较大，低端机或 Windows 上易卡顿。
 * 设为 true 可恢复原有动效；静态层仍为 aurora 渐变 + 点阵纹理。
 */
const ENABLE_ANIMATED_SITE_BACKGROUND = false;

const ParticleField = dynamic(
  () => import("./home/particle-field").then((m) => m.ParticleField),
  { ssr: false },
);

const ConstellationCanvas = dynamic(
  () => import("./home/constellation-canvas").then((m) => m.ConstellationCanvas),
  { ssr: false },
);

export function SiteBackground() {
  const isMobile = useIsMobile();
  const pathname = usePathname();

  if (pathname === "/resume") {
    return null;
  }

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 -z-10"
    >
      {/* Layer 0: Full-viewport aurora gradient wash */}
      <div className="aurora-gradient absolute inset-0" />

      {/* Layer 1: Dot grid texture */}
      <div className="neural-grid absolute inset-0 opacity-[0.07]" />

      {ENABLE_ANIMATED_SITE_BACKGROUND ? (
        <>
          {/* Layer 2: Floating gradient orbs — slow ambient drift */}
          <div
            className="site-bg-orb absolute rounded-full"
            style={{
              animation: "float-orb-1 35s ease-in-out infinite",
              left: "-10%",
              top: "5%",
              width: "70vh",
              height: "70vh",
              background: "radial-gradient(circle, rgba(208,188,255,0.18) 0%, rgba(160,120,255,0.06) 45%, transparent 70%)",
              filter: "blur(60px)",
            }}
          />
          <div
            className="site-bg-orb absolute rounded-full"
            style={{
              animation: "float-orb-2 42s ease-in-out infinite",
              right: "-8%",
              top: "45%",
              width: "65vh",
              height: "65vh",
              background: "radial-gradient(circle, rgba(93,230,255,0.14) 0%, rgba(34,211,238,0.04) 45%, transparent 70%)",
              filter: "blur(60px)",
            }}
          />
          <div
            className="site-bg-orb absolute rounded-full"
            style={{
              animation: "float-orb-3 50s ease-in-out infinite",
              left: "20%",
              bottom: "0%",
              width: "60vh",
              height: "60vh",
              background: "radial-gradient(circle, rgba(255,185,95,0.1) 0%, rgba(255,150,50,0.03) 45%, transparent 70%)",
              filter: "blur(60px)",
            }}
          />

          {/* Layer 3: WebGPU particle flow field — reduced on mobile */}
          <ParticleField global count={isMobile ? 300 : 1200} />

          {/* Layer 4: Constellation network + mouse trails — skip on touch devices */}
          {!isMobile && <ConstellationCanvas />}
        </>
      ) : null}
    </div>
  );
}
