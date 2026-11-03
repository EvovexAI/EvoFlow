/* =========================================================
   Scene 02 · 控制中枢（室内）
   一点透视房间 + 六块实时屏幕 + 全息投影 + 景深尘埃
   ========================================================= */
(function () {
  'use strict';

  const U = CN.utils;
  const P = U.P;

  function rng(seed) {
    let s = seed >>> 0;
    return function () {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  class ControlRoom {
    constructor(engine) {
      this.e = engine;
      this.w = 0;
      this.h = 0;
      this.pad = 90;
      this.screens = [];
      this.dust = [];
      this.glitch = 0;
      this.alert = 0;
      this.alertTimer = 20;
      this.viewX = 0;
      this.viewY = 0;
      this.rot = 0;
    }

    resize(w, h) {
      this.w = w;
      this.h = h;

      this.vpX = w / 2;
      this.vpY = h * 0.44;

      this.backW = Math.min(w * 0.50, h * 0.94);
      this.backH = h * 0.55;
      this.bx = this.vpX - this.backW / 2;
      this.by = this.vpY - this.backH / 2;

      this.buildRoom();
      this.buildScreens();
      this.buildDust();
    }

    /* ================= 房间底 ================= */
    buildRoom() {
      const { w, h, pad, bx, by, backW, backH, vpX, vpY } = this;
      const W = w + pad * 2;
      const H = h + pad * 2;

      const c = U.makeCanvas(W, H);
      const g = c.getContext('2d');

      // 全局底色
      g.fillStyle = '#03010a';
      g.fillRect(0, 0, W, H);

      const ox = pad, oy = pad;
      const vx = vpX + ox, vy = vpY + oy;
      const BX = bx + ox, BY = by + oy;

      // ---- 天花板 ----
      let grd = g.createLinearGradient(0, oy, 0, BY);
      grd.addColorStop(0, '#070314');
      grd.addColorStop(1, '#110929');
      g.fillStyle = grd;
      g.beginPath();
      g.moveTo(ox, oy);
      g.lineTo(ox + w, oy);
      g.lineTo(BX + backW, BY);
      g.lineTo(BX, BY);
      g.closePath();
      g.fill();

      // ---- 左墙 ----
      grd = g.createLinearGradient(ox, 0, BX, 0);
      grd.addColorStop(0, '#0f0928');
      grd.addColorStop(0.65, '#0d0629');
      grd.addColorStop(1, '#1a0d38');
      g.fillStyle = grd;
      g.beginPath();
      g.moveTo(ox, oy);
      g.lineTo(BX, BY);
      g.lineTo(BX, BY + backH);
      g.lineTo(ox, oy + h);
      g.closePath();
      g.fill();

      // ---- 右墙 ----
      grd = g.createLinearGradient(ox + w, 0, BX + backW, 0);
      grd.addColorStop(0, '#0e0727');
      grd.addColorStop(0.6, '#0c0522');
      grd.addColorStop(1, '#180d34');
      g.fillStyle = grd;
      g.beginPath();
      g.moveTo(ox + w, oy);
      g.lineTo(BX + backW, BY);
      g.lineTo(BX + backW, BY + backH);
      g.lineTo(ox + w, oy + h);
      g.closePath();
      g.fill();

      // ---- 后墙 ----
      grd = g.createLinearGradient(0, BY, 0, BY + backH);
      grd.addColorStop(0, '#0c0622');
      grd.addColorStop(1, '#06020f');
      g.fillStyle = grd;
      g.fillRect(BX, BY, backW, backH);

      // ---- 地面 ----
      grd = g.createLinearGradient(0, BY + backH, 0, oy + h);
      grd.addColorStop(0, '#0a0420');
      grd.addColorStop(0.5, '#060214');
      grd.addColorStop(1, '#020008');
      g.fillStyle = grd;
      g.beginPath();
      g.moveTo(BX, BY + backH);
      g.lineTo(BX + backW, BY + backH);
      g.lineTo(ox + w, oy + h);
      g.lineTo(ox, oy + h);
      g.closePath();
      g.fill();

      /* ---------- 结构线 ---------- */
      g.strokeStyle = 'rgba(120,70,200,0.30)';
      g.lineWidth = 1;

      // 墙与墙的交界
      g.beginPath();
      g.moveTo(ox, oy); g.lineTo(BX, BY);
      g.moveTo(ox + w, oy); g.lineTo(BX + backW, BY);
      g.moveTo(ox, oy + h); g.lineTo(BX, BY + backH);
      g.moveTo(ox + w, oy + h); g.lineTo(BX + backW, BY + backH);
      g.stroke();

      // 后墙边框
      g.strokeStyle = 'rgba(160,90,255,0.42)';
      g.lineWidth = 1.6;
      g.strokeRect(BX, BY, backW, backH);

      // 左右墙板缝（沿透视方向，撑起空间感）
      g.strokeStyle = 'rgba(110,70,180,0.17)';
      g.lineWidth = 1;
      for (let i = 1; i <= 4; i++) {
        const k = Math.pow(i / 5, 1.4);

        const lx = U.lerp(BX, ox, k);
        g.beginPath();
        g.moveTo(lx, U.lerp(BY, oy, k));
        g.lineTo(lx, U.lerp(BY + backH, oy + h, k));
        g.stroke();

        const rx = U.lerp(BX + backW, ox + w, k);
        g.beginPath();
        g.moveTo(rx, U.lerp(BY, oy, k));
        g.lineTo(rx, U.lerp(BY + backH, oy + h, k));
        g.stroke();
      }

      // 透视线（天花板格栅 / 地面网格）
      g.lineWidth = 1;
      g.strokeStyle = 'rgba(90,50,160,0.22)';

      // 天花板横向线（指向消失点）
      for (let i = 0; i <= 6; i++) {
        const fx = ox + (w * i) / 6;
        const tx = BX + (backW * i) / 6;
        g.beginPath();
        g.moveTo(fx, oy);
        g.lineTo(tx, BY);
        g.stroke();
      }

      // 保持水平：天花板上的横向短接（按透视间距）
      g.strokeStyle = 'rgba(90,50,160,0.16)';
      for (let i = 0; i < 5; i++) {
        const k = Math.pow(i / 5, 2.2);
        const y = U.lerp(oy, BY, k);
        const lx = U.lerp(ox, BX, k);
        const rx = U.lerp(ox + w, BX + backW, k);
        g.beginPath();
        g.moveTo(lx, y);
        g.lineTo(rx, y);
        g.stroke();
      }

      // 地面网格
      g.strokeStyle = 'rgba(70,180,255,0.10)';
      for (let i = 0; i <= 8; i++) {
        const fx = ox + (w * i) / 8;
        const tx = BX + (backW * i) / 8;
        g.beginPath();
        g.moveTo(fx, oy + h);
        g.lineTo(tx, BY + backH);
        g.stroke();
      }
      for (let i = 0; i < 7; i++) {
        const k = Math.pow(i / 7, 0.55);
        const y = U.lerp(BY + backH, oy + h, k);
        const lx = U.lerp(BX, ox, k);
        const rx = U.lerp(BX + backW, ox + w, k);
        g.beginPath();
        g.moveTo(lx, y);
        g.lineTo(rx, y);
        g.stroke();
      }

      /* ---------- 左墙：管道 + 灯带 + 通风格栅 ---------- */
      g.save();
      g.beginPath();
      g.moveTo(ox, oy);
      g.lineTo(BX, BY);
      g.lineTo(BX, BY + backH);
      g.lineTo(ox, oy + h);
      g.closePath();
      g.clip();

      // 横向管道
      for (let i = 0; i < 3; i++) {
        const fy = oy + h * (0.18 + i * 0.09);
        const ty = BY + backH * (0.18 + i * 0.09);
        g.strokeStyle = i === 0 ? 'rgba(90,40,140,0.75)' : 'rgba(60,30,100,0.55)';
        g.lineWidth = U.lerp(9, 2.4, i / 3);
        g.beginPath();
        g.moveTo(ox - 10, fy);
        g.lineTo(BX, ty);
        g.stroke();
      }

      // 通风口格栅（带内部辉光，避免看起来像一块黑色补丁）
      const gx = ox + w * 0.06, gy = oy + h * 0.34, gw = w * 0.10, gh = h * 0.14;
      g.fillStyle = 'rgba(9,4,20,0.9)';
      g.fillRect(gx, gy, gw, gh);
      g.strokeStyle = 'rgba(120,70,200,0.5)';
      g.lineWidth = 1;
      g.strokeRect(gx + 0.5, gy + 0.5, gw - 1, gh - 1);

      g.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 7; i++) {
        const yy = gy + (gh * (i + 0.5)) / 7;
        const slg = g.createLinearGradient(gx, yy, gx + gw, yy);
        slg.addColorStop(0, 'rgba(0,180,220,0)');
        slg.addColorStop(0.5, 'rgba(0,180,220,0.30)');
        slg.addColorStop(1, 'rgba(0,180,220,0)');
        g.fillStyle = slg;
        g.fillRect(gx, yy, gw, 1.5);
      }
      g.globalCompositeOperation = 'source-over';

      // 灯带（斜向，带发光）
      g.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 2; i++) {
        const fy = oy + h * (0.10 + i * 0.6);
        const ty = BY + backH * (0.10 + i * 0.6);
        const lg = g.createLinearGradient(ox, fy, BX, ty);
        lg.addColorStop(0, U.rgba(P.cyan, 0.0));
        lg.addColorStop(0.4, U.rgba(P.cyan, 0.65));
        lg.addColorStop(1, U.rgba(P.purple, 0.15));
        g.strokeStyle = lg;
        g.lineWidth = 3;
        g.beginPath();
        g.moveTo(ox, fy);
        g.lineTo(BX, ty);
        g.stroke();
      }
      g.globalCompositeOperation = 'source-over';
      g.restore();

      /* ---------- 右墙：机柜阵列 ---------- */
      g.save();
      g.beginPath();
      g.moveTo(ox + w, oy);
      g.lineTo(BX + backW, BY);
      g.lineTo(BX + backW, BY + backH);
      g.lineTo(ox + w, oy + h);
      g.closePath();
      g.clip();

      const racks = 5;
      for (let i = 0; i < racks; i++) {
        const k0 = Math.pow(i / racks, 0.75);
        const k1 = Math.pow((i + 0.82) / racks, 0.75);
        const x0 = U.lerp(ox + w, BX + backW, k0);
        const x1 = U.lerp(ox + w, BX + backW, k1);
        const topY = U.lerp(oy, BY, k0);
        const botY = U.lerp(oy + h, BY + backH, k0);
        const topY1 = U.lerp(oy, BY, k1);
        const botY1 = U.lerp(oy + h, BY + backH, k1);

        g.fillStyle = 'rgba(4,2,12,0.85)';
        g.beginPath();
        g.moveTo(x0, topY + (botY - topY) * 0.08);
        g.lineTo(x1, topY1 + (botY1 - topY1) * 0.08);
        g.lineTo(x1, botY1);
        g.lineTo(x0, botY);
        g.closePath();
        g.fill();

        g.strokeStyle = 'rgba(110,60,180,0.35)';
        g.lineWidth = 1;
        g.stroke();

        // 状态灯
        g.globalCompositeOperation = 'lighter';
        const rows = 5;
        for (let r2 = 0; r2 < rows; r2++) {
          const kk = (r2 + 0.5) / rows;
          const lx = U.lerp(x0, x1, 0.22);
          const ly = U.lerp(topY + (botY - topY) * 0.1, botY, kk);
          const col = U.pick([P.lime, P.cyan, P.amber]);
          U.drawGlow(g, col, lx, ly, 12, 0.5, 0.3);
        }
        g.globalCompositeOperation = 'source-over';
      }
      g.restore();

      /* ---------- 天花板灯带 ---------- */
      g.globalCompositeOperation = 'lighter';
      for (let i = 1; i <= 3; i++) {
        const k = Math.pow(i / 4, 1.6);
        const y = U.lerp(oy, BY, k);
        const lx = U.lerp(ox, BX, k);
        const rx = U.lerp(ox + w, BX + backW, k);
        const lg = g.createLinearGradient(lx, y, rx, y);
        lg.addColorStop(0, 'rgba(0,234,255,0)');
        lg.addColorStop(0.3, 'rgba(0,234,255,0.5)');
        lg.addColorStop(0.7, 'rgba(0,234,255,0.5)');
        lg.addColorStop(1, 'rgba(0,234,255,0)');
        g.fillStyle = lg;
        g.fillRect(lx, y - 1.6, rx - lx, 3.2);
      }
      g.globalCompositeOperation = 'source-over';

      /* ---------- 墙面环境光 ---------- */
      // 后墙整体被屏幕照亮：用竖向渐变，避免出现圆形光斑
      g.globalCompositeOperation = 'lighter';
      const wallGlow = g.createLinearGradient(0, BY, 0, BY + backH);
      wallGlow.addColorStop(0, 'rgba(0,180,220,0.055)');
      wallGlow.addColorStop(0.5, 'rgba(0,200,235,0.022)');
      wallGlow.addColorStop(1, 'rgba(0,160,200,0)');
      g.fillStyle = wallGlow;
      g.fillRect(BX, BY, backW, backH);

      // 左右墙靠近后墙的一侧被照亮
      const lw = g.createLinearGradient(BX - w * 0.3, 0, BX, 0);
      lw.addColorStop(0, 'rgba(0,170,210,0)');
      lw.addColorStop(1, 'rgba(0,170,210,0.075)');
      g.fillStyle = lw;
      g.beginPath();
      g.moveTo(BX - w * 0.3, BY + backH * 0.25);
      g.lineTo(BX, BY);
      g.lineTo(BX, BY + backH);
      g.lineTo(BX - w * 0.3, oy + h);
      g.closePath();
      g.fill();

      const rw = g.createLinearGradient(BX + backW + w * 0.3, 0, BX + backW, 0);
      rw.addColorStop(0, 'rgba(190,40,140,0)');
      rw.addColorStop(1, 'rgba(190,40,140,0.06)');
      g.fillStyle = rw;
      g.beginPath();
      g.moveTo(BX + backW + w * 0.3, BY + backH * 0.25);
      g.lineTo(BX + backW, BY);
      g.lineTo(BX + backW, BY + backH);
      g.lineTo(BX + backW + w * 0.3, oy + h);
      g.closePath();
      g.fill();

      g.globalCompositeOperation = 'source-over';

      /* ---------- 天花板中央灯带 ---------- */
      g.globalCompositeOperation = 'lighter';
      for (let i = -1; i <= 1; i += 2) {
        const cxTop = ox + w / 2 + i * w * 0.14;
        const cxBack = BX + backW / 2 + i * backW * 0.14;
        const tlg = g.createLinearGradient(0, oy, 0, BY);
        tlg.addColorStop(0, 'rgba(0,200,240,0)');
        tlg.addColorStop(0.45, 'rgba(0,200,240,0.20)');
        tlg.addColorStop(1, 'rgba(0,200,240,0.06)');
        g.strokeStyle = tlg;
        g.lineWidth = 2.6;
        g.beginPath();
        g.moveTo(cxTop, oy);
        g.lineTo(cxBack, BY);
        g.stroke();
      }
      g.globalCompositeOperation = 'source-over';

      /* ---------- 后墙底部灯带 ---------- */
      g.globalCompositeOperation = 'lighter';
      const foot = g.createLinearGradient(BX, 0, BX + backW, 0);
      foot.addColorStop(0, 'rgba(0,200,240,0)');
      foot.addColorStop(0.5, 'rgba(0,200,240,0.26)');
      foot.addColorStop(1, 'rgba(0,200,240,0)');
      g.fillStyle = foot;
      g.fillRect(BX, BY + backH - 2.4, backW, 2.6);
      g.globalCompositeOperation = 'source-over';

      this.room = c;
      this.roomPad = pad;
    }

    /* ================= 屏幕布局 ================= */
    buildScreens() {
      const { bx, by, backW, backH } = this;
      const S = [];

      // 主屏
      const mw = backW * 0.46, mh = backH * 0.35;
      S.push({
        x: bx + (backW - mw) / 2, y: by + backH * 0.08,
        w: mw, h: mh, type: 'city', color: P.cyan,
        title: 'SECTOR-07 // 城市监控', t0: 0
      });

      // 左列
      S.push({
        x: bx + backW * 0.045, y: by + backH * 0.10,
        w: backW * 0.19, h: backH * 0.155, type: 'wave', color: P.lime,
        title: '神经信号', t0: 1.3
      });
      S.push({
        x: bx + backW * 0.045, y: by + backH * 0.285,
        w: backW * 0.19, h: backH * 0.155, type: 'bars', color: P.amber,
        title: '负载', t0: 2.7
      });
      S.push({
        x: bx + backW * 0.045, y: by + backH * 0.47,
        w: backW * 0.19, h: backH * 0.185, type: 'code', color: P.magenta,
        title: '数据流', t0: 0.8
      });

      // 右列
      S.push({
        x: bx + backW * 0.765, y: by + backH * 0.10,
        w: backW * 0.19, h: backH * 0.17, type: 'radar', color: P.cyan,
        title: '威胁扫描', t0: 0.4
      });
      S.push({
        x: bx + backW * 0.765, y: by + backH * 0.30,
        w: backW * 0.19, h: backH * 0.355, type: 'globe', color: P.purple,
        title: '全球链路', t0: 2.1
      });

      // 底部滚动条
      const tw = backW * 0.70;
      S.push({
        x: bx + (backW - tw) / 2, y: by + backH * 0.70,
        w: tw, h: backH * 0.075, type: 'ticker', color: P.ice,
        title: '', t0: 0
      });

      this.screens = S;
    }

    buildDust() {
      this.dust = [];
      const n = Math.round(70 * CN.settings.density);
      for (let i = 0; i < n; i++) {
        this.dust.push({
          x: U.rand(0, this.w),
          y: U.rand(0, this.h),
          z: U.rand(0.2, 1),
          vx: U.rand(-6, 6),
          vy: U.rand(-9, -2),
          phase: U.rand(0, U.TAU)
        });
      }
    }

    /* ================= 更新 ================= */
    update(dt, t) {
      const p = this.e.pointer;

      this.viewX = U.approach(this.viewX, p.sx * -30, dt, 3.2);
      this.viewY = U.approach(this.viewY, p.sy * -20, dt, 3.2);

      this.glitch = Math.max(0, this.glitch - dt * 1.8);

      // 偶发警报
      this.alertTimer -= dt;
      if (this.alertTimer <= 0) {
        this.alert = 1;
        this.alertTimer = U.rand(18, 42);
      }
      this.alert = Math.max(0, this.alert - dt * 0.55);

      // 全息投影自转
      this.rot += dt * 0.55;

      // 尘埃
      const q = this.e.quality < 1 ? 0.5 : 1;
      for (let i = 0; i < this.dust.length; i++) {
        if (i % 2 === 0 && q < 1) continue;
        const d = this.dust[i];
        d.x += d.vx * dt * d.z;
        d.y += d.vy * dt * d.z;
        if (d.y < -20) { d.y = this.h + 20; d.x = U.rand(0, this.w); }
        if (d.x < -20) d.x = this.w + 20;
        if (d.x > this.w + 20) d.x = -20;
      }
    }

    onPointerDown() {
      this.glitch = 1;
    }

    /* ================= 绘制 ================= */
    draw(ctx) {
      const { w, h, pad } = this;
      const t = this.e.t;
      const p = this.e.pointer;

      ctx.globalCompositeOperation = 'source-over';

      // 房间底
      ctx.drawImage(this.room, -pad + this.viewX, -pad + this.viewY);

      // 屏幕（跟随房间偏移）
      ctx.save();
      ctx.translate(this.viewX, this.viewY);
      for (const s of this.screens) this.drawScreen(ctx, s, t);
      ctx.restore();

      // 屏幕光溢出到地面
      ctx.save();
      ctx.translate(this.viewX, this.viewY);
      this.drawFloorReflection(ctx, t);
      ctx.restore();

      // 全息投影（近景桌面）
      ctx.save();
      ctx.translate(this.viewX * 1.3, this.viewY * 1.3);
      this.drawHologram(ctx, t);
      ctx.restore();

      // 前景控制台
      this.drawConsole(ctx, t);

      // 尘埃
      this.drawDust(ctx, t);

      // 警报氛围
      if (this.alert > 0.01) {
        const a = Math.sin(t * 8) * 0.5 + 0.5;
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = this.alert * a * 0.09;
        ctx.fillStyle = P.red;
        ctx.fillRect(0, 0, w, h);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
      }

      // 光标
      if (p.idle < 4) {
        const a = U.clamp(1 - p.idle / 4, 0, 1) * 0.22 * CN.settings.glow;
        ctx.globalCompositeOperation = 'lighter';
        U.drawGlow(ctx, P.cyan, p.x, p.y, 300, a, 0.6);
        ctx.globalCompositeOperation = 'source-over';
      }

      this.e.drawRipples(ctx, P.ice, 0.9);
    }

    /* -------- 单块屏幕 -------- */
    drawScreen(ctx, s, t) {
      const glitch = this.glitch;
      ctx.save();
      ctx.translate(s.x, s.y);

      // 外框
      ctx.fillStyle = 'rgba(2,0,8,0.96)';
      U.roundRect(ctx, -3, -3, s.w + 6, s.h + 6, 3);
      ctx.fill();

      ctx.strokeStyle = U.rgba(s.color, 0.42);
      ctx.lineWidth = 1.2;
      U.roundRect(ctx, -3, -3, s.w + 6, s.h + 6, 3);
      ctx.stroke();

      // 屏幕底色
      const bg = ctx.createLinearGradient(0, 0, s.w, s.h);
      bg.addColorStop(0, U.rgba(s.color, 0.07));
      bg.addColorStop(1, 'rgba(2,0,10,0.9)');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, s.w, s.h);

      // 内容
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, s.w, s.h);
      ctx.clip();

      // 故障偏移
      if (glitch > 0.02) {
        const dx = (Math.random() - 0.5) * 8 * glitch;
        ctx.translate(dx, 0);
      }

      switch (s.type) {
        case 'wave': this.drawWave(ctx, s, t); break;
        case 'bars': this.drawBars(ctx, s, t); break;
        case 'radar': this.drawRadar(ctx, s, t); break;
        case 'code': this.drawCode(ctx, s, t); break;
        case 'city': this.drawCity(ctx, s, t); break;
        case 'globe': this.drawGlobe(ctx, s, t); break;
        case 'ticker': this.drawTicker(ctx, s, t); break;
      }

      ctx.restore();

      // 屏幕扫描线（用 pattern 一次铺满）
      ctx.globalCompositeOperation = 'source-over';
      if (!this.scanPat) {
        const pc = U.makeCanvas(2, 3);
        const pg = pc.getContext('2d');
        pg.fillStyle = 'rgba(0,0,0,0.5)';
        pg.fillRect(0, 0, 2, 1);
        this.scanPat = ctx.createPattern(pc, 'repeat');
      }
      ctx.globalAlpha = 0.34;
      ctx.fillStyle = this.scanPat;
      ctx.fillRect(0, 0, s.w, s.h);
      ctx.globalAlpha = 1;

      // 移动的高光带
      const bandY = ((t * 40 + s.t0 * 30) % (s.h + 60)) - 30;
      ctx.globalCompositeOperation = 'lighter';
      const band = ctx.createLinearGradient(0, bandY - 18, 0, bandY + 18);
      band.addColorStop(0, U.rgba(s.color, 0));
      band.addColorStop(0.5, U.rgba(s.color, 0.055));
      band.addColorStop(1, U.rgba(s.color, 0));
      ctx.fillStyle = band;
      ctx.fillRect(0, bandY - 18, s.w, 36);
      ctx.globalCompositeOperation = 'source-over';

      // 标题
      if (s.title) {
        ctx.font = '600 8.5px ui-monospace, Consolas, monospace';
        ctx.fillStyle = U.rgba(s.color, 0.75);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(s.title, 5, 4);
        // 状态点
        const blink = Math.sin(t * 3 + s.t0) > 0 ? 0.9 : 0.25;
        ctx.globalCompositeOperation = 'lighter';
        U.drawGlow(ctx, P.lime, s.w - 8, 8, 10, blink, 0.3);
        ctx.globalCompositeOperation = 'source-over';
      }

      // 屏幕外发光：贴着边框，而不是一个大圆盘
      ctx.globalCompositeOperation = 'lighter';
      const gk = CN.settings.glow;
      if (gk > 0.02) {
        ctx.globalAlpha = 0.09 * gk;
        ctx.strokeStyle = s.color;
        ctx.lineWidth = 7;
        U.roundRect(ctx, -3, -3, s.w + 6, s.h + 6, 3);
        ctx.stroke();

        ctx.globalAlpha = 0.16 * gk;
        ctx.lineWidth = 2;
        U.roundRect(ctx, -3, -3, s.w + 6, s.h + 6, 3);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';

      ctx.restore();
    }

    /* ---- 波形 ---- */
    drawWave(ctx, s, t) {
      const n = 46;
      ctx.globalCompositeOperation = 'lighter';
      for (let layer = 0; layer < 2; layer++) {
        ctx.beginPath();
        for (let i = 0; i <= n; i++) {
          const x = (i / n) * s.w;
          const ph = i * 0.42 + t * (2.2 + layer * 0.9) + s.t0;
          const amp = s.h * (0.16 + layer * 0.1);
          const y = s.h * 0.56 +
            Math.sin(ph) * amp +
            Math.sin(ph * 2.7 + 1.4) * amp * 0.42 +
            Math.sin(ph * 5.3) * amp * 0.16;
          i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.strokeStyle = layer === 0 ? U.rgba(s.color, 0.85) : U.rgba(P.cyan, 0.4);
        ctx.lineWidth = layer === 0 ? 1.3 : 0.8;
        ctx.stroke();
      }
      ctx.globalCompositeOperation = 'source-over';
    }

    /* ---- 柱状 ---- */
    drawBars(ctx, s, t) {
      const n = 14;
      const gap = s.w / n;
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < n; i++) {
        const v = 0.25 + 0.75 * (Math.sin(t * 1.8 + i * 0.7 + s.t0) * 0.5 + 0.5) *
          (0.4 + 0.6 * U.noise1(i * 0.4 + t * 0.6, 7));
        const bh = U.clamp(v, 0.06, 1) * (s.h * 0.72);
        const x = i * gap + gap * 0.2;
        const bw = gap * 0.6;
        const y = s.h * 0.86 - bh;

        const g2 = ctx.createLinearGradient(0, y, 0, s.h * 0.86);
        g2.addColorStop(0, U.rgba(s.color, 0.9));
        g2.addColorStop(1, U.rgba(s.color, 0.12));
        ctx.fillStyle = g2;
        ctx.fillRect(x, y, bw, bh);
      }
      ctx.globalCompositeOperation = 'source-over';
    }

    /* ---- 雷达 ---- */
    drawRadar(ctx, s, t) {
      const cx = s.w / 2, cy = s.h / 2;
      const r = Math.min(s.w, s.h) * 0.42;

      ctx.strokeStyle = U.rgba(s.color, 0.28);
      ctx.lineWidth = 0.8;
      for (let i = 1; i <= 3; i++) {
        ctx.beginPath();
        ctx.arc(cx, cy, (r * i) / 3, 0, U.TAU);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.moveTo(cx - r, cy); ctx.lineTo(cx + r, cy);
      ctx.moveTo(cx, cy - r); ctx.lineTo(cx, cy + r);
      ctx.stroke();

      // 扫描扇形
      const ang = t * 1.9 + s.t0;
      ctx.globalCompositeOperation = 'lighter';
      const grd = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      grd.addColorStop(0, U.rgba(s.color, 0.34));
      grd.addColorStop(1, U.rgba(s.color, 0));
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r, ang - 0.55, ang);
      ctx.closePath();
      ctx.fillStyle = grd;
      ctx.fill();

      // 扫描线
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(ang) * r, cy + Math.sin(ang) * r);
      ctx.strokeStyle = U.rgba(s.color, 0.95);
      ctx.lineWidth = 1.2;
      ctx.stroke();

      // 目标点
      const targets = [[0.35, -0.4], [-0.5, 0.3], [0.15, 0.55], [-0.28, -0.55]];
      for (let i = 0; i < targets.length; i++) {
        const tx = cx + targets[i][0] * r;
        const ty = cy + targets[i][1] * r;
        const angT = Math.atan2(targets[i][1], targets[i][0]);
        let d = ((ang - angT) % U.TAU + U.TAU) % U.TAU;
        const bright = U.clamp(1 - d / 1.6, 0.15, 1);
        U.drawGlow(ctx, i === 1 ? P.red : P.amber, tx, ty, 16, bright * 0.9, 0.3);
      }
      ctx.globalCompositeOperation = 'source-over';
    }

    /* ---- 代码雨 ---- */
    drawCode(ctx, s, t) {
      const cols = Math.max(6, Math.floor(s.w / 11));
      const rows = Math.max(5, Math.floor(s.h / 11));
      const cw = s.w / cols;
      const chh = s.h / rows;

      ctx.font = `${Math.min(10, chh * 0.9)}px ui-monospace, Consolas, monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      for (let c = 0; c < cols; c++) {
        const speed = 0.8 + U.noise1(c * 1.7 + s.t0, 3) * 2.2;
        const head = ((t * speed + c * 3.3) % (rows + 6)) - 3;
        for (let rr = 0; rr < rows; rr++) {
          const dist = head - rr;
          if (dist < 0 || dist > 5) continue;
          const a = U.clamp(1 - dist / 5.5, 0, 1);
          const gi = ((rr * 31 + c * 17 + ((t * 2) | 0)) % U.GLYPHS.length);
          const glyph = U.GLYPHS[gi];
          const x = c * cw + cw / 2;
          const y = rr * chh + chh / 2;
          if (dist < 0.6) {
            ctx.fillStyle = 'rgba(240,255,255,0.95)';
          } else {
            ctx.fillStyle = U.rgba(s.color, a * 0.85);
          }
          ctx.fillText(glyph, x, y);
        }
      }
    }

    /* ---- 城市监控 ---- */
    drawCity(ctx, s, t) {
      const w = s.w, h = s.h;
      const hy = h * 0.62;

      // 夜空
      const sky = ctx.createLinearGradient(0, 0, 0, hy);
      sky.addColorStop(0, 'rgba(14,6,32,0.98)');
      sky.addColorStop(0.6, 'rgba(46,14,62,0.95)');
      sky.addColorStop(1, 'rgba(96,28,74,0.9)');
      ctx.fillStyle = sky;
      ctx.fillRect(0, 0, w, hy);

      // 雾带
      const haze = ctx.createLinearGradient(0, hy - h * 0.22, 0, hy);
      haze.addColorStop(0, 'rgba(120,50,110,0)');
      haze.addColorStop(1, 'rgba(150,70,110,0.3)');
      ctx.fillStyle = haze;
      ctx.fillRect(0, hy - h * 0.22, w, h * 0.22);

      // 建筑群：细而密，高低错落
      const shift = (t * 3.2) % (w + 60);
      const N = 46;
      for (let pass = 0; pass < 2; pass++) {
        // pass 0 = 远排（暗），pass 1 = 近排（更暗更实）
        const scale = pass === 0 ? 1 : 1.25;
        for (let i = 0; i < N; i++) {
          const seed = i * 13 + pass * 7;
          const bw = (3 + U.hash(seed) * 9) * scale;
          const bh = (h * 0.10 + U.hash(seed * 3) * h * 0.38) * scale;
          const x = ((i * (w / N) * 1.15 - shift) % (w + 80)) - 40;
          const y = hy - bh;

          ctx.fillStyle = pass === 0
            ? 'rgba(22,10,40,0.85)'
            : 'rgba(8,3,18,0.96)';
          ctx.fillRect(x, y, bw, bh + 2);

          // 窗灯
          if (pass === 1 && U.hash(seed * 17) > 0.35) {
            const cols = Math.max(1, Math.floor(bw / 2.6));
            const rows = Math.max(1, Math.floor(bh / 3.4));
            for (let r2 = 0; r2 < rows; r2++) {
              for (let c2 = 0; c2 < cols; c2++) {
                if (U.hash(seed * 31 + r2 * 7 + c2) < 0.55) continue;
                const wx = x + 1.4 + c2 * 2.6;
                const wy = y + 2 + r2 * 3.4;
                if (wy > hy - 1) continue;
                const warm = U.hash(seed * 41 + r2 * 3 + c2) > 0.3;
                ctx.fillStyle = warm
                  ? `rgba(255,214,150,${0.35 + U.hash(r2 * 5 + c2) * 0.5})`
                  : `rgba(140,225,255,${0.3 + U.hash(r2 * 9 + c2) * 0.45})`;
                ctx.fillRect(wx, wy, 1.3, 1.8);
              }
            }
          }
        }
      }

      // 地面
      const gnd = ctx.createLinearGradient(0, hy, 0, h);
      gnd.addColorStop(0, 'rgba(28,12,44,0.95)');
      gnd.addColorStop(1, 'rgba(4,1,10,1)');
      ctx.fillStyle = gnd;
      ctx.fillRect(0, hy, w, h - hy);

      // 地面反光
      ctx.globalCompositeOperation = 'lighter';
      const refl = ctx.createLinearGradient(0, hy, 0, h);
      refl.addColorStop(0, 'rgba(200,70,130,0.22)');
      refl.addColorStop(1, 'rgba(120,30,90,0)');
      ctx.fillStyle = refl;
      ctx.fillRect(0, hy, w, h - hy);

      // 扫描带
      const scanY = (t * 24) % (h + 30) - 15;
      const lg = ctx.createLinearGradient(0, scanY - 9, 0, scanY + 9);
      lg.addColorStop(0, 'rgba(0,234,255,0)');
      lg.addColorStop(0.5, 'rgba(0,234,255,0.30)');
      lg.addColorStop(1, 'rgba(0,234,255,0)');
      ctx.fillStyle = lg;
      ctx.fillRect(0, scanY - 9, w, 18);
      ctx.globalCompositeOperation = 'source-over';

      // HUD 角标
      ctx.strokeStyle = 'rgba(0,234,255,0.75)';
      ctx.lineWidth = 1;
      const cs = Math.min(10, h * 0.09);
      const corners = [[2, 13], [w - 2, 13], [2, h - 13], [w - 2, h - 13]];
      for (let i = 0; i < 4; i++) {
        const x = corners[i][0], y = corners[i][1];
        const sx = i % 2 === 0 ? 1 : -1;
        const sy = i < 2 ? 1 : -1;
        ctx.beginPath();
        ctx.moveTo(x + sx * cs, y);
        ctx.lineTo(x, y);
        ctx.lineTo(x, y + sy * cs);
        ctx.stroke();
      }

      // 追踪目标
      const px = w * 0.5 + Math.sin(t * 0.35) * w * 0.30;
      const py = h * 0.38 + Math.cos(t * 0.27) * h * 0.16;
      ctx.strokeStyle = 'rgba(255,59,59,0.85)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(px - 9, py); ctx.lineTo(px - 3, py);
      ctx.moveTo(px + 3, py); ctx.lineTo(px + 9, py);
      ctx.moveTo(px, py - 9); ctx.lineTo(px, py - 3);
      ctx.moveTo(px, py + 3); ctx.lineTo(px, py + 9);
      ctx.stroke();
      ctx.strokeRect(px - 12, py - 12, 24, 24);

      ctx.font = '600 7px ui-monospace, monospace';
      ctx.fillStyle = 'rgba(255,80,80,0.9)';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      ctx.fillText(
        `X:${String(px | 0).padStart(4, '0')} Y:${String(py | 0).padStart(4, '0')}`, 5, h - 4
      );
      ctx.fillStyle = 'rgba(255,80,80,' + (Math.sin(t * 3) > 0 ? 0.95 : 0.25) + ')';
      ctx.textAlign = 'right';
      ctx.fillText('● REC', w - 5, h - 4);

      // 监控画面的轻微色调
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.05;
      ctx.fillStyle = P.cyan;
      ctx.fillRect(0, 0, w, h);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }

    /* ---- 全息球 ---- */
    drawGlobe(ctx, s, t) {
      const cx = s.w / 2;
      const cy = s.h / 2;
      const r = Math.min(s.w * 0.35, s.h * 0.4);

      ctx.globalCompositeOperation = 'lighter';

      // 球体
      ctx.strokeStyle = U.rgba(s.color, 0.55);
      ctx.lineWidth = 0.9;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, U.TAU);
      ctx.stroke();

      // 经线
      for (let i = 1; i < 6; i++) {
        const rx = Math.abs(Math.cos((i / 6) * Math.PI)) * r;
        ctx.beginPath();
        ctx.ellipse(cx, cy, rx, r, 0, 0, U.TAU);
        ctx.stroke();
      }
      // 纬线（随自转倾斜）
      for (let i = 1; i < 5; i++) {
        const ry = Math.abs(Math.cos((i / 5) * Math.PI)) * r;
        ctx.beginPath();
        ctx.ellipse(cx, cy, r, ry, 0, 0, U.TAU);
        ctx.stroke();
      }

      // 旋转的高亮带
      const a = t * 1.2 + s.t0;
      ctx.beginPath();
      ctx.ellipse(cx, cy, r, r * 0.34, 0, a, a + 1.1);
      ctx.strokeStyle = U.rgba(P.cyan, 0.85);
      ctx.lineWidth = 1.6;
      ctx.stroke();

      // 节点
      for (let i = 0; i < 7; i++) {
        const la = U.hash(i * 9) * Math.PI * 2 + t * 0.3;
        const lo = (U.hash(i * 17) - 0.5) * 1.6;
        const nx = cx + Math.cos(la) * Math.cos(lo) * r;
        const ny = cy + Math.sin(lo) * r;
        const vis = Math.cos(la) > -0.2;
        if (!vis) continue;
        U.drawGlow(ctx, i % 3 === 0 ? P.amber : P.cyan, nx, ny, 14, 0.85, 0.3);
      }

      U.drawGlow(ctx, s.color, cx, cy, r * 3.2, 0.10, 0.8);
      ctx.globalCompositeOperation = 'source-over';
    }

    /* ---- 滚动条 ---- */
    drawTicker(ctx, s, t) {
      ctx.font = '600 8px ui-monospace, Consolas, monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = U.rgba(s.color, 0.8);

      const msg = '◤ 链路稳定 · 带宽 84.2TB/s · 神经同步率 99.4% · 冷却系统正常 · 区块高度 #8842013 · 无异常入侵 · ';
      const tw = ctx.measureText(msg).width;
      const off = (t * 42) % tw;
      const y = s.h / 2 + 1;

      for (let i = -1; i < Math.ceil(s.w / tw) + 1; i++) {
        ctx.fillText(msg, i * tw - off, y);
      }
    }

    /* -------- 地面反射 -------- */
    drawFloorReflection(ctx, t) {
      const { bx, by, backW, backH, h } = this;
      const floorTop = by + backH;
      const floorH = h - floorTop;

      ctx.globalCompositeOperation = 'lighter';

      for (const s of this.screens) {
        const cx = s.x + s.w / 2;
        const baseA = 0.17 * (1 - (s.y - by) / backH * 0.35);
        const rh = floorH * 0.9;

        // 三层叠加，让光柱边缘柔和
        for (let layer = 0; layer < 3; layer++) {
          const scale = 1 + layer * 0.62;
          const a = baseA * (0.55 - layer * 0.16);
          if (a <= 0.002) continue;
          const rw = s.w * 0.62 * scale;

          const grd2 = ctx.createLinearGradient(0, floorTop, 0, floorTop + rh);
          grd2.addColorStop(0, U.rgba(s.color, a));
          grd2.addColorStop(0.3, U.rgba(s.color, a * 0.5));
          grd2.addColorStop(0.7, U.rgba(s.color, a * 0.14));
          grd2.addColorStop(1, U.rgba(s.color, 0));

          ctx.fillStyle = grd2;
          ctx.beginPath();
          ctx.moveTo(cx - rw / 2, floorTop);
          ctx.lineTo(cx + rw / 2, floorTop);
          ctx.lineTo(cx + rw * 0.95, floorTop + rh);
          ctx.lineTo(cx - rw * 0.95, floorTop + rh);
          ctx.closePath();
          ctx.fill();
        }
      }

      // 地面主光斑（矩形渐变，不用圆形）
      const fg = ctx.createLinearGradient(0, floorTop, 0, floorTop + floorH * 0.55);
      fg.addColorStop(0, 'rgba(0,220,245,0.10)');
      fg.addColorStop(0.4, 'rgba(0,200,235,0.035)');
      fg.addColorStop(1, 'rgba(0,180,220,0)');
      ctx.fillStyle = fg;
      ctx.fillRect(bx, floorTop, backW, floorH * 0.55);

      // 地板反光横纹
      for (let i = 0; i < 5; i++) {
        const y = floorTop + (floorH / 6) * (i + 1);
        const a = 0.035 + 0.02 * Math.sin(t * 1.2 + i);
        const lg2 = ctx.createLinearGradient(0, y - 12, 0, y + 12);
        lg2.addColorStop(0, 'rgba(160,220,255,0)');
        lg2.addColorStop(0.5, `rgba(160,220,255,${a})`);
        lg2.addColorStop(1, 'rgba(160,220,255,0)');
        ctx.fillStyle = lg2;
        ctx.fillRect(bx, y - 12, backW, 24);
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }

    /* -------- 全息投影 -------- */
    drawHologram(ctx, t) {
      const cx = this.w * 0.5;
      const baseY = this.h * 0.858;                    // 投影底座（桌面）
      const cy = this.h * 0.742;                       // 立方体中心
      const sz = Math.min(this.w, this.h) * 0.058;

      ctx.globalCompositeOperation = 'lighter';

      // 投影锥（从桌面升到立方体）
      const cone = ctx.createLinearGradient(cx, cy - sz, cx, baseY);
      cone.addColorStop(0, U.rgba(P.cyan, 0.012));
      cone.addColorStop(0.5, U.rgba(P.cyan, 0.055));
      cone.addColorStop(1, U.rgba(P.cyan, 0.028));
      ctx.fillStyle = cone;
      ctx.beginPath();
      ctx.moveTo(cx - sz * 1.0, baseY);
      ctx.lineTo(cx + sz * 1.0, baseY);
      ctx.lineTo(cx + sz * 0.30, cy - sz * 0.5);
      ctx.lineTo(cx - sz * 0.30, cy - sz * 0.5);
      ctx.closePath();
      ctx.fill();

      // 底座光环
      ctx.save();
      ctx.translate(cx, baseY);
      ctx.scale(1, 0.24);
      ctx.beginPath();
      ctx.arc(0, 0, sz * 1.15, 0, U.TAU);
      ctx.strokeStyle = U.rgba(P.cyan, 0.55);
      ctx.lineWidth = 2.2;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, 0, sz * 0.62, 0, U.TAU);
      ctx.strokeStyle = U.rgba(P.ice, 0.35);
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.restore();
      U.drawGlow(ctx, P.cyan, cx, baseY, sz * 3.0, 0.28, 0.55);

      // 立方体线框
      const verts = [];
      const a1 = this.rot;
      const a2 = this.rot * 0.63;
      for (let i = 0; i < 8; i++) {
        let x = (i & 1) ? 1 : -1;
        let y = (i & 2) ? 1 : -1;
        let z = (i & 4) ? 1 : -1;

        const nx = x * Math.cos(a1) - z * Math.sin(a1);
        const nz1 = x * Math.sin(a1) + z * Math.cos(a1);
        x = nx; z = nz1;

        const ny = y * Math.cos(a2) - z * Math.sin(a2);
        const nz2 = y * Math.sin(a2) + z * Math.cos(a2);
        y = ny; z = nz2;

        const persp = 3.6 / (3.6 + z);
        verts.push({ x: cx + x * sz * persp, y: cy + y * sz * persp, z });
      }

      const edges = [
        [0, 1], [1, 3], [3, 2], [2, 0],
        [4, 5], [5, 7], [7, 6], [6, 4],
        [0, 4], [1, 5], [2, 6], [3, 7]
      ];

      ctx.lineWidth = 1.15;
      for (const e of edges) {
        const A = verts[e[0]], B = verts[e[1]];
        const zz = (A.z + B.z) / 2;
        const alpha = U.clamp(0.78 - zz * 0.2, 0.10, 0.9);
        ctx.strokeStyle = U.rgba(zz > 0 ? P.cyan : P.ice, alpha);
        ctx.beginPath();
        ctx.moveTo(A.x, A.y);
        ctx.lineTo(B.x, B.y);
        ctx.stroke();
      }

      for (const v of verts) {
        U.drawGlow(ctx, P.cyan, v.x, v.y, sz * 0.42,
                   U.clamp(0.8 - v.z * 0.2, 0.08, 0.9), 0.3);
      }

      U.drawGlow(ctx, P.cyan, cx, cy, sz * 2.4, 0.12, 0.8);

      // 投影闪烁
      if (Math.random() < 0.05) {
        ctx.globalAlpha = 0.07;
        ctx.fillStyle = P.ice;
        ctx.fillRect(cx - sz * 1.1, cy - sz * 1.3, sz * 2.2, sz * 2.6);
        ctx.globalAlpha = 1;
      }

      ctx.globalCompositeOperation = 'source-over';
    }

    /* -------- 前景控制台 -------- */
    drawConsole(ctx, t) {
      const { w, h } = this;
      const cy = h * 0.885;

      // 台面
      const grd = ctx.createLinearGradient(0, cy - 30, 0, h);
      grd.addColorStop(0, '#130a2e');
      grd.addColorStop(1, '#020008');
      ctx.fillStyle = grd;
      ctx.beginPath();
      ctx.moveTo(w * 0.10, cy + 26);
      ctx.lineTo(w * 0.90, cy + 26);
      ctx.lineTo(w * 1.02, h + 10);
      ctx.lineTo(-w * 0.02, h + 10);
      ctx.closePath();
      ctx.fill();

      // 台面前沿高光
      ctx.globalCompositeOperation = 'lighter';
      const edge = ctx.createLinearGradient(w * 0.1, 0, w * 0.9, 0);
      edge.addColorStop(0, U.rgba(P.cyan, 0));
      edge.addColorStop(0.5, U.rgba(P.cyan, 0.5));
      edge.addColorStop(1, U.rgba(P.cyan, 0));
      ctx.strokeStyle = edge;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(w * 0.10, cy + 26);
      ctx.lineTo(w * 0.90, cy + 26);
      ctx.stroke();

      // 台面按钮灯
      for (let i = 0; i < 14; i++) {
        const x = w * 0.16 + i * (w * 0.05);
        const blink = Math.sin(t * (1.2 + i * 0.31) + i) * 0.5 + 0.5;
        const col = i % 4 === 0 ? P.red : (i % 3 === 0 ? P.amber : P.cyan);
        ctx.globalAlpha = 0.35 + blink * 0.6;
        U.drawGlow(ctx, col, x, cy + 34 + Math.sin(i) * 3, 18, 1, 0.32);
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }

    /* -------- 尘埃 -------- */
    drawDust(ctx, t) {
      const p = this.e.pointer;
      ctx.globalCompositeOperation = 'lighter';
      for (const d of this.dust) {
        const px = d.x + p.sx * -8 * d.z;
        const py = d.y + p.sy * -6 * d.z;
        const tw = Math.sin(t * 1.6 + d.phase) * 0.5 + 0.5;
        const a = (0.06 + tw * 0.20) * d.z;
        const sz = 1.5 + d.z * 2.6;
        ctx.fillStyle = `rgba(180,230,255,${a})`;
        ctx.beginPath();
        ctx.arc(px, py, sz * 0.5, 0, U.TAU);
        ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
    }
  }

  CN.scenes = CN.scenes || {};
  CN.scenes.indoor = (engine) => new ControlRoom(engine);
})();
