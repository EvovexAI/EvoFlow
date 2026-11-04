/* =========================================================
   Scene 03 · 数据隧道（纵深）
   对数分布的透视环阵列 + 隧道弯曲 + 速度感
   ========================================================= */
(function () {
  'use strict';

  const U = CN.utils;
  const P = U.P;

  // 沿隧道渐变的色环
  const RING_COLORS = (function () {
    const out = [];
    const stops = [
      { h: 188, s: 100, l: 58 },
      { h: 205, s: 100, l: 64 },
      { h: 262, s: 92, l: 62 },
      { h: 315, s: 100, l: 58 },
      { h: 322, s: 96, l: 56 },
      { h: 270, s: 90, l: 60 }
    ];
    const N = 30;
    for (let i = 0; i < N; i++) {
      const f = (i / N) * stops.length;
      const a = stops[Math.floor(f) % stops.length];
      const b = stops[(Math.floor(f) + 1) % stops.length];
      const k = f - Math.floor(f);
      out.push({
        css: `hsl(${U.lerp(a.h, b.h, k)},${U.lerp(a.s, b.s, k)}%,${U.lerp(a.l, b.l, k)}%)`
      });
    }
    return out;
  })();

  // 切角矩形轮廓（归一化坐标），比圆环更有方向感和透视暗示
  const RING_SHAPE = (function () {
    const hw = 1.0, hh = 0.60, ch = 0.24;
    const corners = [
      [-hw + ch, -hh], [hw - ch, -hh],
      [hw, -hh + ch], [hw, hh - ch],
      [hw - ch, hh], [-hw + ch, hh],
      [-hw, hh - ch], [-hw, -hh + ch]
    ];
    const out = [];
    for (let i = 0; i < 8; i++) {
      const a = corners[i], b = corners[(i + 1) % 8];
      out.push([a[0], a[1]]);
      out.push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
    }
    return out;
  })();

  class DataTunnel {
    constructor(engine) {
      this.e = engine;
      this.zMin = 40;
      this.zMax = 1100;
      this.ringR = 100;
      this.sides = RING_SHAPE.length;
      this.nRings = 20;

      this.phase = 0;
      this.speed = 3.2;
      this.boost = 0;
      this.roll = 0;

      this.turnX = 0;
      this.turnY = 0;

      this.particles = [];
      this.sparks = [];
    }

    resize(w, h) {
      this.w = w;
      this.h = h;
      this.cx = w / 2;
      this.cy = h / 2;
      this.focal = Math.min(w * 0.62, h * 0.55);
      this.buildParticles();
    }

    buildParticles() {
      this.particles = [];
      const n = Math.round(220 * CN.settings.density * (this.e.quality < 1 ? 0.5 : 1));
      for (let i = 0; i < n; i++) {
        this.particles.push({
          ang: U.rand(0, U.TAU),
          rad: U.rand(0.5, 1.5),
          z: U.rand(this.zMin, this.zMax),
          col: U.pick([P.cyan, P.ice, P.magenta, P.violet, '#ffffff']),
          size: U.rand(0.8, 2.4)
        });
      }
    }

    update(dt, t) {
      const p = this.e.pointer;
      const s = CN.settings;

      const target = (2.2 + (p.sy * 0.5 + 0.5) * 3.4) * s.speed;
      this.speed = U.approach(this.speed, target, dt, 2.2);
      this.boost = Math.max(0, this.boost - dt * 1.1);

      const v = this.speed + this.boost * 9;
      this.phase += v * dt;

      // 归一化的隧道转向
      this.turnX = U.approach(this.turnX, p.sx * 0.55 + Math.sin(t * 0.27) * 0.28, dt, 1.6);
      this.turnY = U.approach(this.turnY, p.sy * 0.40 + Math.cos(t * 0.21) * 0.20, dt, 1.6);
      this.roll += dt * 0.05;

      const dz = v * dt;
      for (const d of this.particles) {
        d.z -= dz * (this.zMax - this.zMin) / 220;
        if (d.z < this.zMin) {
          d.z = this.zMax;
          d.ang = U.rand(0, U.TAU);
          d.rad = U.rand(0.5, 1.5);
        }
      }

      for (let i = this.sparks.length - 1; i >= 0; i--) {
        const sp = this.sparks[i];
        sp.age += dt;
        sp.z -= dz * (this.zMax - this.zMin) / 180;
        if (sp.age > 2.2 || sp.z < this.zMin) this.sparks.splice(i, 1);
      }
    }

    onPointerDown() {
      this.boost = 1;
      for (let i = 0; i < 30; i++) {
        this.sparks.push({
          ang: U.rand(0, U.TAU),
          rad: U.rand(0.15, 1.5),
          z: U.rand(200, 1100),
          age: 0,
          col: U.pick([P.cyan, P.magenta, P.ice, P.amber])
        });
      }
    }

    // u ∈ [0,1]：0 = 已在眼前，1 = 最远
    zAt(u) {
      return this.zMin * Math.exp(Math.log(this.zMax / this.zMin) * u);
    }

    bendAt(u, t) {
      // 隧道中心线：远端收敛到画面中心，越靠近观众偏移越大。
      // 偏移必须随「深度」变化，隧道才会弯曲；若随半径变化就只是同心圆。
      const w = Math.pow(1 - u, 1.3);
      const wob = Math.sin(u * 5.2 + t * 0.7) * 0.30 +
                  Math.sin(u * 9.1 - t * 0.4) * 0.11;
      const x = this.turnX * 0.46 * w + wob * 0.34;
      const y = this.turnY * 0.36 * w + Math.cos(u * 4.1 + t * 0.55) * 0.10;
      return { x: x * this.ringR * 1.1, y: y * this.ringR * 1.1 };
    }

    // 取某个轮廓点在指定深度处的屏幕位置
    pointAt(j, u, t) {
      const z = this.zAt(u);
      const k = this.focal / z;
      const bend = this.bendAt(u, t);
      const cosR = Math.cos(this.roll), sinR = Math.sin(this.roll);
      const sx = RING_SHAPE[j][0] * this.ringR;
      const sy = RING_SHAPE[j][1] * this.ringR;
      const wx = sx * cosR - sy * sinR + bend.x;
      const wy = sx * sinR + sy * cosR + bend.y;
      return { x: this.cx + wx * k, y: this.cy + wy * k, k };
    }

    /* ================= 绘制 ================= */
    draw(ctx) {
      const { w, h } = this;
      const t = this.e.t;

      // 深空背景
      ctx.globalCompositeOperation = 'source-over';
      const bg = ctx.createRadialGradient(
        this.cx, this.cy, 0, this.cx, this.cy, Math.max(w, h) * 0.72
      );
      bg.addColorStop(0, '#10061f');
      bg.addColorStop(0.4, '#07020f');
      bg.addColorStop(1, '#010005');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, w, h);

      // 远处核心微光
      ctx.globalCompositeOperation = 'lighter';
      U.drawGlow(ctx, P.violet, this.cx, this.cy, Math.min(w, h) * 0.85,
                 0.14 + this.boost * 0.18, 0.85);
      ctx.globalCompositeOperation = 'source-over';

      // ---- 环（远 → 近）----
      const rings = [];

      for (let i = 0; i < this.nRings; i++) {
        let u = (i - this.phase) / this.nRings;
        u = u - Math.floor(u);            // 0..1

        const z = this.zAt(u);
        const k = this.focal / z;

        const fadeIn = U.clamp((1 - u) / 0.24, 0, 1);
        const fadeOut = U.clamp(u / 0.20, 0, 1);
        const dim = Math.sqrt(fadeIn * fadeOut);
        if (dim < 0.02) continue;

        const bend = this.bendAt(u, t);
        const R = this.ringR;

        // 颜色沿深度渐变：深处青，近处粉紫
        const ci = Math.min(
          RING_COLORS.length - 1,
          Math.max(0, Math.floor((1 - u) * RING_COLORS.length))
        );
        const col = RING_COLORS[ci].css;
        const lw = U.clamp(k * 1.7, 0.7, 6.5);

        const pts = [];
        const cosR = Math.cos(this.roll), sinR = Math.sin(this.roll);
        for (let j = 0; j < this.sides; j++) {
          const sx = RING_SHAPE[j][0] * R;
          const sy = RING_SHAPE[j][1] * R;
          // 整体缓慢自转
          const wx = sx * cosR - sy * sinR + bend.x;
          const wy = sx * sinR + sy * cosR + bend.y;
          pts.push({ x: this.cx + wx * k, y: this.cy + wy * k });
        }
        pts.push({ x: pts[0].x, y: pts[0].y });   // 闭合

        rings.push({ u, k, dim, col, lw, pts });
      }

      // 远的先画
      rings.sort((a, b) => b.u - a.u);

      ctx.globalCompositeOperation = 'lighter';

      // ---- 纵向管壁骨架：把相邻环对应的顶点连起来 ----
      for (let i = 0; i < rings.length - 1; i++) {
        const A = rings[i], B = rings[i + 1];
        if (Math.abs(A.u - B.u) > 0.3) continue;   // 跨越循环边界，不连

        const a = Math.min(A.dim, B.dim) * 0.20;
        if (a < 0.008) continue;

        ctx.globalAlpha = a;
        ctx.strokeStyle = A.col;
        ctx.lineWidth = U.clamp((A.lw + B.lw) * 0.18, 0.3, 1.9);

        ctx.beginPath();
        for (let j = 0; j < this.sides; j++) {
          ctx.moveTo(A.pts[j].x, A.pts[j].y);
          ctx.lineTo(B.pts[j].x, B.pts[j].y);
        }
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      // ---- 管壁流光：沿纵向筋向观众方向滑动的高亮段 ----
      for (let j = 0; j < this.sides; j += 2) {
        for (let s = 0; s < 2; s++) {
          let ph = (t * 0.42 + j * 0.083 + s * 0.5) % 1;
          const u1 = 1 - ph * 0.92;
          const u2 = u1 - 0.10;
          if (u2 <= 0.02) continue;

          const A = this.pointAt(j, u1, t);
          const B = this.pointAt(j, u2, t);

          const fadeIn = U.clamp((1 - u1) / 0.24, 0, 1);
          const fadeOut = U.clamp(u1 / 0.20, 0, 1);
          const dim = Math.sqrt(fadeIn * fadeOut) * 0.95;
          if (dim < 0.03) continue;

          const ci = Math.min(
            RING_COLORS.length - 1,
            Math.max(0, Math.floor((1 - u1) * RING_COLORS.length))
          );
          const col = RING_COLORS[ci].css;

          ctx.globalAlpha = dim;
          ctx.strokeStyle = col;
          ctx.lineWidth = U.clamp(A.k * 3.4, 1.6, 7);
          ctx.beginPath();
          ctx.moveTo(A.x, A.y);
          ctx.lineTo(B.x, B.y);
          ctx.stroke();

          // 拖尾
          const C = this.pointAt(j, Math.min(0.99, u2 + 0.06), t);
          const tail = ctx.createLinearGradient(C.x, C.y, A.x, A.y);
          tail.addColorStop(0, 'rgba(255,255,255,0)');
          tail.addColorStop(1, col);
          ctx.globalAlpha = dim * 0.5;
          ctx.strokeStyle = tail;
          ctx.lineWidth = U.clamp(A.k * 1.4, 0.8, 3.4);
          ctx.beginPath();
          ctx.moveTo(C.x, C.y);
          ctx.lineTo(A.x, A.y);
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
      for (const r of rings) {
        ctx.beginPath();
        for (let j = 0; j < r.pts.length; j++) {
          j === 0 ? ctx.moveTo(r.pts[j].x, r.pts[j].y)
                  : ctx.lineTo(r.pts[j].x, r.pts[j].y);
        }

        ctx.globalAlpha = r.dim * 0.78;
        ctx.strokeStyle = r.col;
        ctx.lineWidth = r.lw;
        ctx.stroke();

        ctx.globalAlpha = r.dim * 0.38;
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = Math.max(0.25, r.lw * 0.22);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      // ---- 数据包（沿环流动的光点）----
      this.drawPackets(ctx, t);

      // ---- 侧壁粒子 ----
      this.drawParticles(ctx);

      // ---- 火花 ----
      this.drawSparks(ctx, t);

      // ---- 中心奇点 ----
      this.drawSingularity(ctx, t);

      // ---- 交互 ----
      ctx.globalCompositeOperation = 'source-over';
      this.e.drawRipples(ctx, P.cyan, 1.1);

      const p = this.e.pointer;
      if (p.idle < 4) {
        const a = U.clamp(1 - p.idle / 4, 0, 1) * 0.20 * CN.settings.glow;
        ctx.globalCompositeOperation = 'lighter';
        U.drawGlow(ctx, P.cyan, p.x, p.y, 240, a, 0.65);
        ctx.globalCompositeOperation = 'source-over';
      }

      ctx.globalCompositeOperation = 'source-over';
    }

    drawPackets(ctx, t) {
      ctx.globalCompositeOperation = 'lighter';
      const count = 12;
      for (let i = 0; i < count; i++) {
        const ph = (t * (0.10 + i * 0.021) + i * 0.37) % 1;
        const u = 1 - ph;                     // 从远到近
        const z = this.zAt(u);
        const k = this.focal / z;

        const fadeIn = U.clamp((1 - u) / 0.09, 0, 1);
        const fadeOut = U.clamp(u / 0.13, 0, 1);
        const dim = Math.sqrt(fadeIn * fadeOut);
        if (dim < 0.05) continue;

        const a = (i / count) * U.TAU + t * 1.1;
        const bend = this.bendAt(u, t);
        const wx = Math.cos(a) * this.ringR * 0.95 + bend.x;
        const wy = Math.sin(a) * this.ringR * 0.56 + bend.y;
        const x = this.cx + wx * k;
        const y = this.cy + wy * k;

        const col = RING_COLORS[(i * 7) % RING_COLORS.length].css;
        U.drawGlow(ctx, col, x, y, U.clamp(k * 40, 8, 190), dim * 0.75, 0.3);
      }
      ctx.globalCompositeOperation = 'source-over';
    }

    drawParticles(ctx) {
      ctx.globalCompositeOperation = 'lighter';
      const t = this.e.t;
      for (const d of this.particles) {
        const u = Math.log(d.z / this.zMin) / Math.log(this.zMax / this.zMin);
        if (u < 0 || u > 1) continue;
        const fadeIn = U.clamp((1 - u) / 0.09, 0, 1);
        const fadeOut = U.clamp(u / 0.13, 0, 1);
        const dim = Math.sqrt(fadeIn * fadeOut);
        if (dim < 0.04) continue;

        const k = this.focal / d.z;
        const bend = this.bendAt(u, t);
        const wx = Math.cos(d.ang) * this.ringR * d.rad * 0.95 + bend.x;
        const wy = Math.sin(d.ang) * this.ringR * d.rad * 0.56 + bend.y;
        const sz = U.clamp(d.size * k * 0.55, 0.4, 4);

        ctx.globalAlpha = dim * 0.8;
        ctx.fillStyle = d.col;
        ctx.beginPath();
        ctx.arc(this.cx + wx * k, this.cy + wy * k, sz, 0, U.TAU);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }

    drawSparks(ctx, t) {
      ctx.globalCompositeOperation = 'lighter';
      for (const sp of this.sparks) {
        const fade = U.clamp(1 - sp.age / 2.2, 0, 1);
        if (fade <= 0.02) continue;
        const u = Math.log(sp.z / this.zMin) / Math.log(this.zMax / this.zMin);
        if (u < 0 || u > 1) continue;
        const k = this.focal / sp.z;
        const bend = this.bendAt(u, t);
        const wx = Math.cos(sp.ang) * this.ringR * sp.rad * 0.95 + bend.x;
        const wy = Math.sin(sp.ang) * this.ringR * sp.rad * 0.56 + bend.y;
        U.drawGlow(ctx, sp.col, this.cx + wx * k, this.cy + wy * k,
                   U.clamp(k * 34, 5, 110), fade * 0.85, 0.3);
      }
      ctx.globalCompositeOperation = 'source-over';
    }

    drawSingularity(ctx, t) {
      ctx.globalCompositeOperation = 'lighter';
      const pulse = 0.9 + Math.sin(t * 1.4) * 0.1;
      const sz = Math.min(this.w, this.h) * 0.020 * pulse;

      U.drawGlow(ctx, '#ffffff', this.cx, this.cy, sz * 4, 0.34, 0.32);
      U.drawGlow(ctx, P.cyan, this.cx, this.cy, sz * 12, 0.10, 0.75);

      // 极细的十字光斑
      ctx.globalAlpha = 0.35;
      const an = ctx.createLinearGradient(this.cx - sz * 7, this.cy, this.cx + sz * 7, this.cy);
      an.addColorStop(0, 'rgba(120,240,255,0)');
      an.addColorStop(0.5, 'rgba(220,250,255,0.8)');
      an.addColorStop(1, 'rgba(120,240,255,0)');
      ctx.fillStyle = an;
      ctx.fillRect(this.cx - sz * 7, this.cy - 0.7, sz * 14, 1.4);
      ctx.save();
      ctx.translate(this.cx, this.cy);
      ctx.rotate(Math.PI / 2);
      ctx.fillStyle = an;
      ctx.fillRect(-sz * 7, -0.7, sz * 14, 1.4);
      ctx.restore();
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }
  }

  CN.scenes = CN.scenes || {};
  CN.scenes.tunnel = (engine) => new DataTunnel(engine);
})();
