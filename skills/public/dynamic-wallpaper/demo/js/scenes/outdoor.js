/* =========================================================
   Scene 01 · 雨夜霓虹城（室外）
   分层预渲染天际线 + 高架单轨 + 车流 + 飞行器 + 湿地倒影
   ========================================================= */
(function () {
  'use strict';

  const U = CN.utils;
  const P = U.P;

  // 窗光色板：以真实城市的暖光为主，霓虹色作点缀
  const WIN_WARM = ['#ffe9c4', '#ffd79a', '#ffc47a', '#fff3dd'];
  const WIN_COOL = ['#b9e6ff', '#7df9ff', '#b48cff', '#ff9ec4'];

  function rng(seed) {
    let s = seed >>> 0;
    return function () {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  class OutdoorCity {
    constructor(engine) {
      this.e = engine;
      this.w = 0;
      this.h = 0;
      this.horizon = 0;

      this.signs = [];
      this.flickers = [];
      this.crafts = [];
      this.cars = [];
      this.rain = [];
      this.trainX = -1e6;
      this.trainTimer = 10;

      this.cloudA = null;
      this.cloudB = null;
    }

    /* ================= 构建 ================= */
    resize(w, h) {
      this.w = w;
      this.h = h;
      this.horizon = Math.round(h * 0.73);
      this.padW = Math.round(w + 220);

      this.buildSky();

      this.signs = [];
      this.flickers = [];

      // 远景：低对比、被雾包裹
      this.farLayer = this.buildCityLayer({
        seed: 4021,
        minH: 0.09, maxH: 0.24,
        minW: 18, maxW: 52,
        top: '#0f0a22', bot: '#1a1132',
        litRatio: 0.09,
        palette: WIN_WARM.concat(['#9b8cd8']),
        winW: 2.0, winH: 2.8, gapX: 1.6, gapY: 2.6,
        signs: 0, parallax: 12,
        fog: 0.72, alpha: 0.85,
        edge: 0.35
      });

      // 中景：细节最丰富
      this.midLayer = this.buildCityLayer({
        seed: 8832,
        minH: 0.18, maxH: 0.44,
        minW: 38, maxW: 96,
        top: '#0a0619', bot: '#150c2c',
        litRatio: 0.17,
        palette: WIN_WARM.concat(WIN_COOL),
        winW: 3.4, winH: 4.8, gapX: 2.4, gapY: 3.6,
        signs: 14, parallax: 24,
        fog: 0.26, alpha: 1,
        edge: 0.6
      });

      // 近景：剪影 + 大窗 + 边缘霓虹
      this.nearLayer = this.buildCityLayer({
        seed: 1355,
        minH: 0.34, maxH: 0.78,
        minW: 66, maxW: 150,
        top: '#030109', bot: '#080414',
        litRatio: 0.11,
        palette: WIN_WARM.concat([P.cyan, P.magenta]),
        winW: 6.4, winH: 9.2, gapX: 4.4, gapY: 6.8,
        signs: 7, parallax: 42,
        fog: 0.03, alpha: 1,
        edge: 1.0,
        sides: true
      });

      this.buildTraffic();
      this.buildCrafts();
      this.buildRain();

      // 远景并入天空层：少一次全屏合成，视觉差异可忽略
      const sg = this.sky.getContext('2d');
      sg.globalAlpha = 0.85;
      sg.drawImage(this.farLayer, 0, 0);
      sg.globalAlpha = 1;
      this.farLayer = null;
    }

    /* -------- 天空 -------- */
    buildSky() {
      const { w, h } = this;
      const hy = this.horizon;
      const c = U.makeCanvas(this.padW, h);
      const g = c.getContext('2d');

      const grd = g.createLinearGradient(0, 0, 0, hy);
      grd.addColorStop(0.00, '#03000a');
      grd.addColorStop(0.35, '#08031a');
      grd.addColorStop(0.62, '#120726');
      grd.addColorStop(0.82, '#1d0a30');
      grd.addColorStop(0.93, '#2b0d33');
      grd.addColorStop(1.00, '#3a1230');
      g.fillStyle = grd;
      g.fillRect(0, 0, this.padW, hy + 4);

      // 地平线城市光污染（窄而暖）
      const glow = g.createLinearGradient(0, hy - 130, 0, hy + 6);
      glow.addColorStop(0, 'rgba(255,110,60,0)');
      glow.addColorStop(0.62, 'rgba(255,100,80,0.07)');
      glow.addColorStop(1, 'rgba(255,150,90,0.20)');
      g.fillStyle = glow;
      g.fillRect(0, hy - 130, this.padW, 136);

      // 巨型环状天体（远、暗、被雾减弱）
      const mx = this.padW * 0.70;
      const my = hy * 0.24;
      const mr = Math.min(this.w, this.h) * 0.075;

      g.globalCompositeOperation = 'lighter';
      // 天体只保留环体本身，不加外扩光晕（大范围径向渐变会露出圆形边界）

      g.save();
      g.translate(mx, my);
      g.scale(1, 0.40);
      g.beginPath();
      g.arc(0, 0, mr, 0, U.TAU);
      g.lineWidth = mr * 0.10;
      g.strokeStyle = 'rgba(255,150,180,0.42)';
      g.stroke();
      g.beginPath();
      g.arc(0, 0, mr * 1.30, 0, U.TAU);
      g.lineWidth = mr * 0.028;
      g.strokeStyle = 'rgba(230,90,150,0.28)';
      g.stroke();

      g.beginPath();
      g.arc(0, 0, mr * 0.95, 0, U.TAU);
      const mg = g.createRadialGradient(0, 0, mr * 0.2, 0, 0, mr);
      mg.addColorStop(0, 'rgba(90,16,55,0.55)');
      mg.addColorStop(1, 'rgba(45,8,35,0.10)');
      g.fillStyle = mg;
      g.fill();
      g.restore();

      // 星点
      const r = rng(1207);
      g.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 70; i++) {
        const x = r() * this.padW;
        const y = r() * hy * 0.55;
        const a = (1 - y / (hy * 0.55)) * 0.42 * r();
        g.fillStyle = `rgba(200,220,255,${a})`;
        g.fillRect(x, y, 1, 1);
      }
      g.globalCompositeOperation = 'source-over';

      this.sky = c;
    }

    /* -------- 城市层 -------- */
    buildCityLayer(opt) {
      const { h } = this;
      const padW = this.padW;
      const baseY = this.horizon;

      const layer = U.makeCanvas(padW, h);
      const g = layer.getContext('2d');
      const r = rng(opt.seed);

      const blds = [];
      let x = -90;
      let guard = 0;

      while (x < padW + 90 && guard++ < 200) {
        const bw = U.lerp(opt.minW, opt.maxW, Math.pow(r(), 1.3));
        const bh = baseY * U.lerp(opt.minH, opt.maxH, Math.pow(r(), 0.9));

        // 近景只在两侧生成，中间留出视野
        let skip = false;
        if (opt.sides) {
          const cx = x / padW;
          const inCenter = cx > 0.26 && cx < 0.74;
          if (inCenter) {
            if (bh > baseY * 0.34) skip = true;
          }
        }

        if (!skip) {
          blds.push({ x, w: bw, h: bh, top: baseY - bh, seed: r() });
        }
        x += bw * U.lerp(0.52, 0.86, r());
      }

      // 先铺一层楼体
      for (const b of blds) {
        this.paintBuildingBody(g, b, opt, r);
      }
      // 再铺窗格（避免后画的楼覆盖前一栋的窗户）
      for (const b of blds) {
        this.paintWindows(g, b, opt, r);
      }
      // 顶部结构
      for (const b of blds) {
        this.paintRoofDetail(g, b, opt, r);
      }

      // 楼层雾
      if (opt.fog > 0.01) {
        const fog = g.createLinearGradient(0, baseY - h * 0.45, 0, baseY + 30);
        fog.addColorStop(0, 'rgba(26,10,54,0)');
        fog.addColorStop(0.55, `rgba(30,12,58,${opt.fog * 0.5})`);
        fog.addColorStop(1, `rgba(46,16,66,${opt.fog})`);
        g.fillStyle = fog;
        g.fillRect(0, baseY - h * 0.45, padW, h * 0.45 + 30);
      }

      // 招牌
      if (opt.signs > 0 && blds.length) {
        for (let i = 0; i < opt.signs; i++) {
          const b = blds[Math.floor(r() * blds.length)];
          if (!b || b.h < 90 || b.w < 34) continue;
          const color = U.pick([P.cyan, P.magenta, P.amber, P.purple, P.pink, P.ice]);
          const txt = U.pick(U.SIGNS);
          const vertical = r() < 0.5 && b.h > 160;
          this.signs.push(this.makeSign(txt, color, vertical, b, r, opt.parallax));
        }
      }

      return layer;
    }

    /* 楼体 */
    paintBuildingBody(g, b, opt, r) {
      const grad = g.createLinearGradient(0, b.top, 0, b.top + b.h);
      grad.addColorStop(0, opt.top);
      grad.addColorStop(0.55, U.mixHex(opt.top, opt.bot, 0.5));
      grad.addColorStop(1, opt.bot);
      g.fillStyle = grad;
      g.fillRect(b.x, b.top, b.w, b.h + 2);

      // 顶面亮线（天空光反射）
      g.fillStyle = U.rgba('#6a4a9c', 0.30 * opt.edge + 0.08);
      g.fillRect(b.x, b.top, b.w, 1);

      // 左侧暗面 / 右侧受光
      const sideG = g.createLinearGradient(b.x, 0, b.x + b.w, 0);
      sideG.addColorStop(0, 'rgba(0,0,0,0.40)');
      sideG.addColorStop(0.45, 'rgba(0,0,0,0)');
      sideG.addColorStop(1, 'rgba(120,90,190,0.05)');
      g.fillStyle = sideG;
      g.fillRect(b.x, b.top, b.w, b.h + 2);

      // 边缘霓虹灯带
      if (r() < opt.edge * 0.7) {
        const ec = U.pick([P.cyan, P.magenta, P.purple, P.amber]);
        g.globalCompositeOperation = 'lighter';
        const ex = r() < 0.5 ? b.x + 1 : b.x + b.w - 1;
        const hh = b.h * U.rand(0.3, 0.8);
        const eg = g.createLinearGradient(0, b.top, 0, b.top + hh);
        eg.addColorStop(0, U.rgba(ec, 0));
        eg.addColorStop(0.3, U.rgba(ec, 0.55 * opt.edge));
        eg.addColorStop(0.75, U.rgba(ec, 0.30 * opt.edge));
        eg.addColorStop(1, U.rgba(ec, 0));
        g.fillStyle = eg;
        g.fillRect(ex - 1.1, b.top, 2.2, hh);
        g.globalCompositeOperation = 'source-over';
      }

      // 楼脚被街灯映暖
      const warm = g.createLinearGradient(0, b.top + b.h * 0.78, 0, b.top + b.h);
      warm.addColorStop(0, 'rgba(255,120,50,0)');
      warm.addColorStop(1, 'rgba(255,130,60,0.075)');
      g.fillStyle = warm;
      g.fillRect(b.x, b.top + b.h * 0.78, b.w, b.h * 0.22);
    }

    /* 窗格 */
    paintWindows(g, b, opt, r) {
      const winW = opt.winW, winH = opt.winH;
      const stepX = winW + opt.gapX;
      const stepY = winH + opt.gapY;

      const padX = Math.max(4, b.w * 0.07);
      const cols = Math.max(1, Math.floor((b.w - padX * 2) / stepX));
      const rows = Math.max(1, Math.floor((b.h - 14) / stepY));

      // 整栋楼的「入住率」——大量窗户的亮暗成片出现，更真实
      const floorLit = [];
      for (let row = 0; row < rows; row++) {
        // 每隔几层有一个"暗层"
        const band = U.hash( Math.floor(row / 4) + b.seed * 97 );
        floorLit.push(band > 0.3 ? 1 : 0.25);
      }

      // 暗窗底色（整片先铺一次，减少绘制调用）
      const darkAlpha = 0.07 + opt.edge * 0.04;
      g.fillStyle = `rgba(120,130,190,${darkAlpha})`;
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const wx = b.x + padX + col * stepX;
          const wy = b.top + 10 + row * stepY;
          // 抽样绘制暗窗，密度略低于实心
          if ((col + row) % 3 === 0) continue;
          g.fillRect(wx, wy, winW, winH);
        }
      }

      // 亮窗
      const baseLit = opt.litRatio;
      for (let row = 0; row < rows; row++) {
        const fl = floorLit[row];
        for (let col = 0; col < cols; col++) {
          if (r() > baseLit * fl) continue;

          const wx = b.x + padX + col * stepX;
          const wy = b.top + 10 + row * stepY;

          // 冷色窗占比低
          const cold = r() < 0.20;
          const col2 = cold ? U.pick(WIN_COOL) : U.pick(WIN_WARM);

          const bright = U.lerp(0.26, 0.95, Math.pow(r(), 2.2));
          g.fillStyle = U.rgba(col2, bright);
          g.fillRect(wx, wy, winW, winH);

          // 极少数窗额外提亮
          if (bright > 0.9 && r() < 0.3) {
            g.fillStyle = 'rgba(255,255,255,0.35)';
            g.fillRect(wx, wy, winW, winH * 0.5);
          }

          // 登记少量闪烁窗
          if (r() < 0.008 && this.flickers.length < 70) {
            this.flickers.push({
              x: wx + winW / 2,
              y: wy + winH / 2,
              w: winW * 2.2,
              color: col2,
              phase: r() * 100
            });
          }
        }
      }
    }

    /* 楼顶细节 */
    paintRoofDetail(g, b, opt, r) {
      const roll = r();
      if (roll < 0.20) {
        // 天线
        const ax = b.x + b.w * U.lerp(0.25, 0.75, r());
        const ah = U.rand(12, 46) * (opt.winW / 3.4 + 0.4);
        g.strokeStyle = 'rgba(90,70,140,0.75)';
        g.lineWidth = 1.2;
        g.beginPath();
        g.moveTo(ax, b.top);
        g.lineTo(ax, b.top - ah);
        g.stroke();

        g.globalCompositeOperation = 'lighter';
        U.drawGlow(g, P.red, ax, b.top - ah, 16, 0.85, 0.28);
        g.globalCompositeOperation = 'source-over';
      } else if (roll < 0.52) {
        // 顶部设备层（退台）
        const iw = b.w * U.rand(0.3, 0.6);
        const ih = U.rand(8, 22) * (opt.winW / 3.4 + 0.3);
        const ix = b.x + (b.w - iw) * r();
        g.fillStyle = U.mixHex(opt.top, '#000000', 0.3);
        g.fillRect(ix, b.top - ih, iw, ih);
        g.fillStyle = U.rgba('#5a4080', 0.28);
        g.fillRect(ix, b.top - ih, iw, 0.9);
      } else if (roll < 0.62) {
        // 顶置广告牌
        const sw = b.w * U.rand(0.5, 0.85);
        const sh = U.rand(10, 18);
        const sx = b.x + (b.w - sw) / 2;
        g.fillStyle = 'rgba(6,2,14,0.95)';
        g.fillRect(sx, b.top - sh - 3, sw, sh);
        g.strokeStyle = U.rgba(U.pick([P.cyan, P.magenta, P.amber]), 0.5);
        g.lineWidth = 1;
        g.strokeRect(sx + 0.5, b.top - sh - 2.5, sw - 1, sh - 1);
      }
    }

    /* -------- 霓虹招牌 -------- */
    makeSign(text, color, vertical, b, r, parallax) {
      const fs = vertical ? 19 : 16;
      const pad = 9;

      let W, H, chars = [];
      if (vertical) {
        chars = text.slice(0, 4).split('');
        W = fs + pad * 2;
        H = chars.length * (fs + 3) + pad * 2;
      } else {
        W = Math.min(text.length, 8) * fs * 0.78 + pad * 2.2;
        H = fs + pad * 1.5;
      }

      if (W > b.w - 6) W = Math.max(28, b.w - 6);

      const c = U.makeCanvas(W, H);
      const g = c.getContext('2d');

      // 背板
      g.fillStyle = 'rgba(3,0,9,0.86)';
      U.roundRect(g, 0, 0, W, H, 2.5);
      g.fill();

      // 灯管边框
      g.globalCompositeOperation = 'lighter';
      g.strokeStyle = U.rgba(color, 0.42);
      g.lineWidth = 2.6;
      U.roundRect(g, 1.4, 1.4, W - 2.8, H - 2.8, 2);
      g.stroke();

      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.font = `700 ${fs}px "Microsoft YaHei","Noto Sans SC",ui-sans-serif,sans-serif`;

      const paint = (alpha, blur, lw, fill) => {
        g.globalAlpha = alpha;
        g.shadowColor = color;
        g.shadowBlur = blur;
        g.lineWidth = lw;
        g.strokeStyle = U.rgba(color, 0.92);
        g.fillStyle = fill;
        if (vertical) {
          chars.forEach((ch, i) => {
            const y = pad + (fs + 3) * i + fs / 2 + 1;
            g.strokeText(ch, W / 2, y);
            if (fill !== 'transparent') g.fillText(ch, W / 2, y);
          });
        } else {
          const y = H / 2 + 1;
          const t2 = text.slice(0, 8);
          g.strokeText(t2, W / 2, y, W - 6);
          if (fill !== 'transparent') g.fillText(t2, W / 2, y, W - 6);
        }
      };

      paint(0.85, 12, 2.8, 'transparent');
      paint(1, 5, 1.3, 'transparent');
      paint(1, 1.5, 0.5, '#ffffff');

      g.globalAlpha = 1;
      g.shadowBlur = 0;
      g.globalCompositeOperation = 'source-over';

      const sx = b.x + U.rand(3, Math.max(4, b.w - W - 3));
      const sy = b.top + U.rand(16, Math.max(24, b.h * 0.5));

      return {
        img: c, x: sx, y: sy, w: W, h: H, color, parallax,
        mode: r(), phase: r() * U.TAU, speed: U.rand(0.4, 2.2),
        cx: sx + W / 2
      };
    }

    /* -------- 动态元素 -------- */
    buildTraffic() {
      this.cars = [];
      const lanes = [
        { y: this.horizon + 14, dir: 1, speed: 150, w: 12, color: P.ice, n: 6 },
        { y: this.horizon + 46, dir: -1, speed: 200, w: 15, color: '#ffd9a0', n: 5 },
        { y: this.horizon + 96, dir: 1, speed: 280, w: 20, color: P.magenta, n: 4 }
      ];
      for (const ln of lanes) {
        for (let i = 0; i < ln.n; i++) {
          this.cars.push({
            x: U.rand(-this.w, this.w * 1.4),
            y: ln.y + U.rand(-3, 3),
            dir: ln.dir,
            speed: ln.speed * U.rand(0.8, 1.25),
            len: ln.w * U.rand(0.9, 1.5),
            color: ln.color
          });
        }
      }
    }

    buildCrafts() {
      this.crafts = [];
      for (let i = 0; i < 4; i++) {
        this.crafts.push({
          x: U.rand(0, this.w),
          y: U.rand(this.h * 0.05, this.h * 0.38),
          speed: U.rand(12, 34) * (U.chance(0.5) ? 1 : -1),
          bob: U.rand(0, U.TAU),
          scale: U.rand(0.55, 1.1),
          color: U.pick([P.cyan, P.amber, P.magenta])
        });
      }
    }

    buildRain() {
      const wanted = Math.round(620 * CN.settings.density * (this.e.quality < 1 ? 0.6 : 1));
      while (this.rain.length > wanted) this.rain.pop();
      while (this.rain.length < wanted) this.rain.push(this.newDrop(true));
    }

    newDrop(anywhere) {
      const near = U.chance(0.22);
      return {
        x: U.rand(-this.w * 0.3, this.w * 1.3),
        y: anywhere ? U.rand(0, this.h) : U.rand(-this.h * 0.25, -10),
        len: near ? U.rand(22, 48) : U.rand(9, 22),
        speed: near ? U.rand(950, 1450) : U.rand(520, 880),
        near
      };
    }

    /* ================= 更新 ================= */
    update(dt, t) {
      this.buildRain();

      const windX = 110 + Math.sin(t * 0.22) * 70;
      for (let i = 0; i < this.rain.length; i++) {
        const d = this.rain[i];
        d.y += d.speed * dt;
        d.x += windX * dt;
        if (d.y > this.h + 40 || d.x > this.w * 1.4) {
          this.rain[i] = this.newDrop(false);
        }
      }

      for (const c of this.cars) {
        c.x += c.speed * c.dir * dt;
        if (c.dir > 0 && c.x > this.w * 1.35) c.x = -this.w * 0.35;
        if (c.dir < 0 && c.x < -this.w * 0.35) c.x = this.w * 1.35;
      }

      for (const c of this.crafts) {
        c.x += c.speed * dt;
        c.y += Math.sin(t * 0.5 + c.bob) * 5 * dt;
        if (c.x > this.w + 120) c.x = -120;
        if (c.x < -120) c.x = this.w + 120;
      }

      this.trainTimer -= dt;
      if (this.trainTimer <= 0) {
        this.trainX = -this.w * 0.55;
        this.trainTimer = U.rand(30, 62);
      }
      if (this.trainX < this.w * 1.4) this.trainX += 190 * dt;
    }

    /* ================= 绘制 ================= */
    draw(ctx) {
      const t = this.e.t;
      const p = this.e.pointer;

      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;

      // 天空（已含远景天际线）
      ctx.drawImage(this.sky, -110 + p.sx * -11, 0);

      // 低空光雾（缓慢呼吸的横向雾带，替代纹理云）
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 2; i++) {
        const yy = this.horizon * (0.58 + i * 0.16);
        const hh = this.horizon * 0.36;
        const a = 0.032 + 0.018 * Math.sin(t * 0.23 + i * 2.1);
        const grd = ctx.createLinearGradient(0, yy - hh / 2, 0, yy + hh / 2);
        grd.addColorStop(0, 'rgba(150,45,130,0)');
        grd.addColorStop(0.5, `rgba(150,45,130,${a})`);
        grd.addColorStop(1, 'rgba(150,45,130,0)');
        ctx.fillStyle = grd;
        ctx.fillRect(0, yy - hh / 2, this.w, hh);
      }
      ctx.globalCompositeOperation = 'source-over';

      // 中景
      ctx.drawImage(this.midLayer, -110 + p.sx * -24, 0);

      // 单轨
      this.drawMonorail(ctx, t);

      // 中景招牌
      this.drawSigns(ctx, t, 24);

      // 近景
      ctx.drawImage(this.nearLayer, -110 + p.sx * -42, 0);

      // 近景招牌
      this.drawSigns(ctx, t, 42);

      // 地面
      this.drawGround(ctx, t);

      // 车流
      this.drawCars(ctx);

      // 窗灯闪烁
      this.drawFlickers(ctx, t);

      // 飞行器
      this.drawCrafts(ctx, t);

      // 雨
      this.drawRain(ctx);

      // 交互
      ctx.globalCompositeOperation = 'source-over';
      this.e.drawRipples(ctx, P.cyan, 1);

      if (p.idle < 4) {
        const a = U.clamp(1 - p.idle / 4, 0, 1) * 0.22 * CN.settings.glow;
        ctx.globalCompositeOperation = 'lighter';
        U.drawGlow(ctx, P.cyan, p.x, p.y, 300, a, 0.62);
        U.drawGlow(ctx, P.magenta, p.x, p.y, 120, a * 0.45, 0.45);
        ctx.globalCompositeOperation = 'source-over';
      }
    }

    drawMonorail(ctx, t) {
      const y = this.horizon - 118;
      const p = this.e.pointer;
      const off = p.sx * -20;

      // 桥体
      ctx.fillStyle = 'rgba(5,2,13,0.72)';
      ctx.fillRect(0, y, this.w, 9);
      ctx.fillStyle = 'rgba(90,50,140,0.28)';
      ctx.fillRect(0, y, this.w, 1);

      // 支撑柱
      ctx.fillStyle = 'rgba(4,1,10,0.62)';
      for (let x = -40 + off; x < this.w + 60; x += 140) {
        ctx.fillRect(x, y + 9, 7, this.horizon - y - 9);
      }

      // 底部灯带
      ctx.globalCompositeOperation = 'lighter';
      const g2 = ctx.createLinearGradient(0, y + 8, 0, y + 15);
      g2.addColorStop(0, U.rgba(P.cyan, 0.11));
      g2.addColorStop(1, U.rgba(P.cyan, 0));
      ctx.fillStyle = g2;
      ctx.fillRect(0, y + 8, this.w, 7);
      ctx.globalCompositeOperation = 'source-over';

      // 列车
      if (this.trainX > -this.w * 0.6 && this.trainX < this.w * 1.4) {
        const tx = this.trainX;
        const tlen = 300;
        ctx.fillStyle = '#080414';
        U.roundRect(ctx, tx, y - 14, tlen, 15, 2.5);
        ctx.fill();
        ctx.strokeStyle = U.rgba(P.cyan, 0.35);
        ctx.lineWidth = 0.9;
        U.roundRect(ctx, tx, y - 14, tlen, 15, 2.5);
        ctx.stroke();

        ctx.globalCompositeOperation = 'lighter';
        for (let i = 0; i < 14; i++) {
          const wx = tx + 10 + i * 20;
          const on = (Math.sin(i * 1.7 + t * 0.5) * 0.5 + 0.5) > 0.2;
          ctx.fillStyle = on ? 'rgba(200,235,255,0.9)' : 'rgba(40,55,80,0.6)';
          ctx.fillRect(wx, y - 11, 11, 6);
        }
        U.drawGlow(ctx, P.cyan, tx + (this.trainX > 0 ? tlen : 0), y - 7, 90, 0.45, 0.5);
        ctx.globalCompositeOperation = 'source-over';
      }
    }

    drawSigns(ctx, t, parallax) {
      const p = this.e.pointer;
      const off = p.sx * -parallax;

      for (const s of this.signs) {
        if (s.parallax !== parallax) continue;

        let a = 1;
        if (s.mode < 0.10) {
          a = (Math.sin(t * 19 + s.phase) > 0.25) ? 1 : 0.3;
          if (Math.random() < 0.03) a = 0.1;
        } else if (s.mode < 0.24) {
          a = 0.78 + 0.22 * Math.sin(t * s.speed + s.phase);
        }

        ctx.globalAlpha = a;
        ctx.drawImage(s.img, s.x + off - 110, s.y);
        ctx.globalAlpha = 1;
      }
    }

    /* 湿地倒影：分层竖直光柱，比单个径向贴图更干净 */
    drawReflection(ctx, color, cx, y0, w, h, alpha) {
      if (alpha <= 0.005) return;
      const sprite = U.reflectSprite(color);
      ctx.globalCompositeOperation = 'lighter';
      const layers = [0.34, 0.24, 0.15, 0.08];
      for (let i = 0; i < layers.length; i++) {
        const ww = w * (1 + i * 0.95);
        ctx.globalAlpha = alpha * layers[i];
        ctx.drawImage(sprite, cx - ww / 2, y0, ww, h);
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }

    drawGround(ctx, t) {
      const { w, h } = this;
      const hy = this.horizon;
      const gh = h - hy;
      const p = this.e.pointer;

      // 湿沥青
      const g = ctx.createLinearGradient(0, hy, 0, h);
      g.addColorStop(0, '#0d0618');
      g.addColorStop(0.25, '#07020f');
      g.addColorStop(1, '#010004');
      ctx.fillStyle = g;
      ctx.fillRect(0, hy, w, gh);

      // 街面接收的环境光（很淡）
      const hg = ctx.createLinearGradient(0, hy, 0, hy + gh * 0.30);
      hg.addColorStop(0, 'rgba(180,60,110,0.13)');
      hg.addColorStop(1, 'rgba(120,25,80,0)');
      ctx.fillStyle = hg;
      ctx.fillRect(0, hy, w, gh * 0.30);

      // 招牌倒影
      for (const s of this.signs) {
        const off = p.sx * -(s.parallax || 24);
        const cx = s.cx + off - 110;
        const jitter = Math.sin(t * 2.6 + s.phase) * 3 + Math.sin(t * 6.1 + s.phase * 2) * 1.4;
        const rh = gh * U.clamp(0.5 + s.h / 300, 0.32, 0.95);
        this.drawReflection(ctx, s.color, cx + jitter, hy + 2, s.w * 1.05, rh, 0.30);
      }

      // 楼层底部溢光（整条街的底色反光）
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 5; i++) {
        const x = (w / 5) * i + w * 0.1;
        const col = i % 2 ? P.purple : P.magenta;
        this.drawReflection(ctx, col, x, hy, 90, gh * 0.55, 0.10);
      }

      // 车道线
      ctx.globalAlpha = 0.16;
      const lanes = [0.20, 0.36, 0.55, 0.76];
      for (const k of lanes) {
        const yy = hy + gh * k;
        const gk = ctx.createLinearGradient(0, yy, w, yy);
        const a = 0.5 * (1 - k * 0.7);
        gk.addColorStop(0, 'rgba(150,205,255,0)');
        gk.addColorStop(0.35, `rgba(150,205,255,${a})`);
        gk.addColorStop(0.65, `rgba(150,205,255,${a * 0.8})`);
        gk.addColorStop(1, 'rgba(150,205,255,0)');
        ctx.strokeStyle = gk;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, yy);
        ctx.lineTo(w, yy + Math.sin(t * 0.7 + k * 5) * 1.1);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';

      // 湿润路面的水面高光
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 3; i++) {
        const yy = hy + gh * (0.42 + i * 0.2);
        const a = 0.025 + 0.012 * Math.sin(t * 1.4 + i * 2);
        const gs = ctx.createLinearGradient(0, yy, 0, yy + 22);
        gs.addColorStop(0, 'rgba(180,220,255,0)');
        gs.addColorStop(0.4, `rgba(180,220,255,${a})`);
        gs.addColorStop(1, 'rgba(180,220,255,0)');
        ctx.fillStyle = gs;
        ctx.fillRect(0, yy, w, 22);
      }
      ctx.globalCompositeOperation = 'source-over';

      // 地面雾
      const mist = ctx.createLinearGradient(0, hy - 4, 0, hy + gh * 0.38);
      mist.addColorStop(0, 'rgba(52,18,70,0.34)');
      mist.addColorStop(1, 'rgba(52,18,70,0)');
      ctx.fillStyle = mist;
      ctx.fillRect(0, hy - 4, w, gh * 0.38);
    }

    drawCars(ctx) {
      ctx.globalCompositeOperation = 'lighter';
      for (const c of this.cars) {
        const dir = c.dir;
        const tailLen = c.len * 9;
        const grd = ctx.createLinearGradient(c.x, c.y, c.x - dir * tailLen, c.y);
        grd.addColorStop(0, U.rgba(c.color, 0.55));
        grd.addColorStop(1, U.rgba(c.color, 0));
        ctx.fillStyle = grd;
        ctx.fillRect(Math.min(c.x, c.x - dir * tailLen), c.y - 1.6, tailLen, 3.2);

        U.drawGlow(ctx, c.color, c.x, c.y, c.len * 2.2, 0.55, 0.4);
        this.drawReflection(ctx, c.color, c.x, c.y + 3, c.len * 1.6, 54, 0.18);
      }
      ctx.globalCompositeOperation = 'source-over';
    }

    drawFlickers(ctx, t) {
      ctx.globalCompositeOperation = 'lighter';
      const n = Math.min(this.flickers.length, 18);
      const base = (t * 2.5) | 0;
      for (let i = 0; i < n; i++) {
        const idx = (base * 7 + i * 13) % this.flickers.length;
        const f = this.flickers[idx];
        const blink = Math.sin(t * 1.6 + f.phase) * 0.5 + 0.5;
        if (blink < 0.45) continue;
        U.drawGlow(ctx, f.color, f.x, f.y, f.w * 4, (blink - 0.45) * 0.5, 0.4);
      }
      ctx.globalCompositeOperation = 'source-over';
    }

    drawCrafts(ctx, t) {
      ctx.globalCompositeOperation = 'lighter';
      for (const c of this.crafts) {
        const dir = c.speed > 0 ? 1 : -1;
        const sc = c.scale;
        const tl = 70 * sc;
        const grd = ctx.createLinearGradient(c.x, c.y, c.x - dir * tl, c.y);
        grd.addColorStop(0, U.rgba(c.color, 0.42));
        grd.addColorStop(1, U.rgba(c.color, 0));
        ctx.fillStyle = grd;
        ctx.fillRect(Math.min(c.x, c.x - dir * tl), c.y - 0.9 * sc, tl, 1.8 * sc);

        U.drawGlow(ctx, c.color, c.x, c.y, 34 * sc, 0.8, 0.45);
        U.drawGlow(ctx, '#ffffff', c.x, c.y, 9 * sc, 0.85, 0.25);

        const blink = Math.sin(t * 2.6 + c.bob) > 0.55 ? 1 : 0.1;
        U.drawGlow(ctx, P.red, c.x - dir * 5 * sc, c.y + 2 * sc, 18 * sc, blink * 0.6, 0.3);
      }
      ctx.globalCompositeOperation = 'source-over';
    }

    drawRain(ctx) {
      const windX = 110 + Math.sin(this.e.t * 0.22) * 70;
      const slope = windX / 840;

      ctx.globalCompositeOperation = 'lighter';
      ctx.lineCap = 'round';

      const ripples = this.e.ripples;
      const hasRip = ripples.length > 0;

      for (let pass = 0; pass < 2; pass++) {
        const nearPass = pass === 1;
        ctx.strokeStyle = nearPass
          ? 'rgba(200,230,255,0.30)'
          : 'rgba(150,180,255,0.15)';
        ctx.lineWidth = nearPass ? 1.15 : 0.8;

        ctx.beginPath();
        for (let i = 0; i < this.rain.length; i++) {
          const d = this.rain[i];
          if (d.near !== nearPass) continue;

          if (hasRip) {
            let hide = false;
            for (let ri = 0; ri < ripples.length; ri++) {
              const r = ripples[ri];
              const rad = 40 + (r.age / r.life) * 460;
              const dx = d.x - r.x, dy = d.y - r.y;
              if (dx * dx + dy * dy < rad * rad * 0.72) { hide = true; break; }
            }
            if (hide) continue;
          }

          ctx.moveTo(d.x, d.y);
          ctx.lineTo(d.x - d.len * slope, d.y - d.len);
        }
        ctx.stroke();
      }

      ctx.globalCompositeOperation = 'source-over';
    }
  }

  CN.scenes = CN.scenes || {};
  CN.scenes.outdoor = (engine) => new OutdoorCity(engine);
})();
