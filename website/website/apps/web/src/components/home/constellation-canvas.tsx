"use client";

import { useEffect, useRef } from "react";

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  baseAlpha: number;
  alpha: number;
  phase: number;
}

interface Trail {
  x: number;
  y: number;
  alpha: number;
  r: number;
  vx: number;
  vy: number;
}

const LINE_MAX_DIST = 120;
const MOUSE_RADIUS = 200;

export function ConstellationCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let w = 0;
    let h = 0;
    let mouseX = -9999;
    let mouseY = -9999;
    let smoothX = -9999;
    let smoothY = -9999;
    let particles: Particle[] = [];
    let trails: Trail[] = [];
    let animId = 0;
    let lastTrailTime = 0;

    const isDark = () => !document.documentElement.classList.contains("light");

    function resize() {
      const dpr = Math.min(devicePixelRatio, 2);
      w = window.innerWidth;
      h = window.innerHeight;
      canvas!.width = w * dpr;
      canvas!.height = h * dpr;
      canvas!.style.width = w + "px";
      canvas!.style.height = h + "px";
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function createParticle(): Particle {
      const speed = Math.random() * 0.15 + 0.05;
      return {
        x: Math.random() * w,
        y: Math.random() * h,
        vx: (Math.random() - 0.5) * speed * 2,
        vy: (Math.random() - 0.5) * speed * 2,
        r: Math.random() * 1.8 + 0.5,
        baseAlpha: Math.random() * 0.3 + 0.08,
        alpha: 0.1,
        phase: Math.random() * Math.PI * 2,
      };
    }

    function updateParticle(p: Particle, t: number) {
      p.vx += Math.sin(t * 0.0003 + p.phase) * 0.002;
      p.vy += Math.cos(t * 0.0003 + p.phase * 1.3) * 0.002;
      p.x += p.vx;
      p.y += p.vy;

      if (p.x < -10) p.x = w + 10;
      if (p.x > w + 10) p.x = -10;
      if (p.y < -10) p.y = h + 10;
      if (p.y > h + 10) p.y = -10;

      const dx = p.x - smoothX;
      const dy = p.y - smoothY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < MOUSE_RADIUS) {
        const proximity = 1 - dist / MOUSE_RADIUS;
        p.alpha += (p.baseAlpha + proximity * 0.5 - p.alpha) * 0.08;
        const force = proximity * proximity * 0.25;
        p.vx += (dx / dist) * force * 0.06;
        p.vy += (dy / dist) * force * 0.06;
      } else {
        p.alpha += (p.baseAlpha - p.alpha) * 0.03;
      }

      const maxV = 0.8;
      const v = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
      if (v > maxV) {
        p.vx *= maxV / v;
        p.vy *= maxV / v;
      }
      p.vx *= 0.992;
      p.vy *= 0.992;
    }

    function drawParticle(p: Particle) {
      const dark = isDark();
      ctx!.beginPath();
      ctx!.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx!.fillStyle = dark
        ? `rgba(210,187,255,${p.alpha})`
        : `rgba(124,58,237,${p.alpha * 0.5})`;
      ctx!.fill();
    }

    function drawLines() {
      const dark = isDark();
      for (let i = 0; i < particles.length; i++) {
        const pi = particles[i];
        for (let j = i + 1; j < particles.length; j++) {
          const pj = particles[j];
          const dx = pi.x - pj.x;
          const dy = pi.y - pj.y;
          if (Math.abs(dx) > LINE_MAX_DIST || Math.abs(dy) > LINE_MAX_DIST) continue;
          const distSq = dx * dx + dy * dy;
          if (distSq < LINE_MAX_DIST * LINE_MAX_DIST) {
            const dist = Math.sqrt(distSq);
            const alpha = (1 - dist / LINE_MAX_DIST) * 0.1;
            ctx!.beginPath();
            ctx!.moveTo(pi.x, pi.y);
            ctx!.lineTo(pj.x, pj.y);
            ctx!.strokeStyle = dark
              ? `rgba(210,187,255,${alpha})`
              : `rgba(124,58,237,${alpha * 0.55})`;
            ctx!.lineWidth = 0.4;
            ctx!.stroke();
          }
        }
      }
    }

    function init() {
      resize();
      const count = Math.min(Math.floor((w * h) / 10000), 120);
      particles = Array.from({ length: count }, createParticle);
    }

    function animate(t: number) {
      ctx!.clearRect(0, 0, w, h);

      smoothX += (mouseX - smoothX) * 0.1;
      smoothY += (mouseY - smoothY) * 0.1;

      // Mouse trails
      if (smoothX > 0 && t - lastTrailTime > 20) {
        for (let i = 0; i < 2; i++) {
          const angle = Math.random() * Math.PI * 2;
          const speed = Math.random() * 0.4 + 0.1;
          trails.push({
            x: smoothX + (Math.random() - 0.5) * 24,
            y: smoothY + (Math.random() - 0.5) * 24,
            alpha: 0.45,
            r: Math.random() * 2.2 + 0.6,
            vx: Math.cos(angle) * speed,
            vy: Math.sin(angle) * speed,
          });
        }
        lastTrailTime = t;
      }

      // Update and draw trails
      const dark = isDark();
      trails = trails.filter((tr) => tr.alpha > 0);
      for (const tr of trails) {
        tr.x += tr.vx;
        tr.y += tr.vy;
        tr.alpha -= 0.007;
        tr.r *= 0.988;
        tr.vx *= 0.98;
        tr.vy *= 0.98;
        if (tr.alpha <= 0) continue;
        ctx!.beginPath();
        ctx!.arc(tr.x, tr.y, tr.r, 0, Math.PI * 2);
        ctx!.fillStyle = dark
          ? `rgba(210,187,255,${tr.alpha})`
          : `rgba(124,58,237,${tr.alpha * 0.4})`;
        ctx!.fill();
      }

      // Update and draw particles + lines
      for (const p of particles) updateParticle(p, t);
      for (const p of particles) drawParticle(p);
      drawLines();

      animId = requestAnimationFrame(animate);
    }

    const onMove = (e: MouseEvent) => {
      mouseX = e.clientX;
      mouseY = e.clientY;
    };
    const onOut = () => {
      mouseX = -9999;
      mouseY = -9999;
      smoothX = -9999;
      smoothY = -9999;
    };

    let resizeTimer: ReturnType<typeof setTimeout>;
    const onResize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(init, 150);
    };

    window.addEventListener("resize", onResize);
    window.addEventListener("mousemove", onMove, { passive: true });
    window.addEventListener("mouseout", onOut);

    init();
    animId = requestAnimationFrame(animate);

    return () => {
      cancelAnimationFrame(animId);
      clearTimeout(resizeTimer);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseout", onOut);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: "fixed",
        inset: 0,
        pointerEvents: "none",
      }}
    />
  );
}
