/* =========================================================
   CyberNeon · engine
   主循环 / 尺寸适配 / 指针输入 / 廉价 Bloom / 自适应降级
   ========================================================= */
(function () {
  'use strict';

  const U = CN.utils;

  CN.settings = {
    scene: 'outdoor',
    density: 1.0,   // 雨量 / 粒子密度
    glow: 1.0,      // 辉光强度
    speed: 1.0,     // 运动速度
    bloom: true,
    autoRotate: false,
    paused: false
  };

  const STORE_KEY = 'cyberneon.settings.v1';
  CN.loadSettings = function () {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) Object.assign(CN.settings, JSON.parse(raw));
    } catch (e) { /* ignore */ }
  };
  CN.saveSettings = function () {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(CN.settings)); } catch (e) { /* ignore */ }
  };

  class Engine {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d', { alpha: false });

      this.w = 0;
      this.h = 0;
      this.dpr = 1;

      this.t = 0;          // 场景时间（秒），受 paused 影响
      this.wall = 0;       // 真实墙钟时间
      this.dt = 0;

      this.scenes = {};
      this.scene = null;
      this.sceneName = '';

      // 指针
      this.pointer = {
        x: 0, y: 0,        // 当前
        nx: 0, ny: 0,      // 归一化 -1..1
        sx: 0, sy: 0,      // 平滑（带阻尼）
        vx: 0, vy: 0,      // 速度
        down: false,
        idle: 0            // 静止秒数
      };
      this.lastPointer = { x: 0, y: 0 };

      this.ripples = [];
      this.fade = 1;       // 场景切换遮罩
      this.flash = 0;      // 点击白闪

      // 自适应质量
      this.fps = 60;
      this._fpsAcc = 0;
      this._fpsFrames = 0;
      this.quality = 1;    // 1 = 满血，0.7 = 降级

      // 后处理贴图
      this._buildOverlays();

      this._onResize = this.resize.bind(this);
      window.addEventListener('resize', this._onResize);

      this._bindInput();

      this.last = performance.now();
      this._raf = null;
    }

    /* ---------------- 初始化 ---------------- */
    _buildOverlays() {
      // 扫描线贴图
      const sl = U.makeCanvas(4, 4);
      const sc = sl.getContext('2d');
      sc.fillStyle = 'rgba(0,0,0,0.55)';
      sc.fillRect(0, 0, 4, 1.2);
      this.scanPattern = sl;

      // 噪点贴图
      const nz = U.makeCanvas(160, 160);
      const nc = nz.getContext('2d');
      const img = nc.createImageData(160, 160);
      for (let i = 0; i < img.data.length; i += 4) {
        const v = 128 + (Math.random() * 2 - 1) * 90;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
        img.data[i + 3] = 255;
      }
      nc.putImageData(img, 0, 0);
      this.noiseCanvas = nz;
    }

    resize() {
      const w = Math.max(320, window.innerWidth);
      const h = Math.max(240, window.innerHeight);

      // 大屏幕限制像素密度：动态壁纸优先保证帧率
      const cssPx = w * h;
      let maxDpr = 2;
      if (cssPx > 4.2e6) maxDpr = 1;        // 4K 及以上
      else if (cssPx > 2.6e6) maxDpr = 1.5; // 2.5K / 1440p

      const dpr = Math.min(window.devicePixelRatio || 1, maxDpr);

      this.w = w;
      this.h = h;
      this.dpr = dpr;

      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
      this.canvas.style.width = w + 'px';
      this.canvas.style.height = h + 'px';
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.ctx.imageSmoothingEnabled = true;

      // Bloom 缓冲：低分辨率
      this.bloomA = U.makeCanvas(w / 5 + 1, h / 5 + 1);
      this.bloomACtx = this.bloomA.getContext('2d');
      this.bloomB = U.makeCanvas(w / 15 + 1, h / 15 + 1);
      this.bloomBCtx = this.bloomB.getContext('2d');

      // 缓存的 pattern / 渐变（避免每帧重建）
      this._scanPat = null;
      this._noisePat = null;
      this._vignette = null;

      if (this.scene && this.scene.resize) this.scene.resize(w, h);
    }

    /* ---------------- 输入 ---------------- */
    _bindInput() {
      const p = this.pointer;

      const setPos = (cx, cy) => {
        p.x = cx;
        p.y = cy;
        p.nx = (cx / this.w) * 2 - 1;
        p.ny = (cy / this.h) * 2 - 1;
        p.idle = 0;
      };

      window.addEventListener('mousemove', (e) => {
        p.vx = e.clientX - p.x;
        p.vy = e.clientY - p.y;
        setPos(e.clientX, e.clientY);
      }, { passive: true });

      window.addEventListener('mousedown', (e) => {
        // 点到界面控件时不触发壁纸反馈
        if (e.target && e.target.closest &&
            e.target.closest('#panel, #hud, #toast, #hotzone')) return;

        p.down = true;
        this.addRipple(e.clientX, e.clientY, 1);
        this.flash = 1;
        if (this.scene && this.scene.onPointerDown) {
          this.scene.onPointerDown(e.clientX, e.clientY);
        }
      });

      window.addEventListener('mouseup', () => { p.down = false; });

      window.addEventListener('touchstart', (e) => {
        const t = e.touches[0];
        if (!t) return;
        if (e.target && e.target.closest &&
            e.target.closest('#panel, #hud, #toast, #hotzone')) return;
        setPos(t.clientX, t.clientY);
        p.down = true;
        this.addRipple(t.clientX, t.clientY, 1);
        this.flash = 1;
        if (this.scene && this.scene.onPointerDown) {
          this.scene.onPointerDown(t.clientX, t.clientY);
        }
      }, { passive: true });

      window.addEventListener('touchmove', (e) => {
        const t = e.touches[0];
        if (!t) return;
        p.vx = t.clientX - p.x;
        p.vy = t.clientY - p.y;
        setPos(t.clientX, t.clientY);
      }, { passive: true });

      window.addEventListener('touchend', () => { p.down = false; }, { passive: true });

      window.addEventListener('blur', () => { p.down = false; });

      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) this.last = performance.now();
      });
    }

    addRipple(x, y, power = 1) {
      this.ripples.push({
        x, y,
        age: 0,
        life: 1.8,
        power,
        seed: Math.random() * 1000
      });
      if (this.ripples.length > 12) this.ripples.shift();
    }

    /* ---------------- 场景 ---------------- */
    register(name, factory) {
      this.scenes[name] = factory;
    }

    setScene(name, silent) {
      if (!this.scenes[name] || this.sceneName === name) return;

      if (this.scene && this.scene.destroy) this.scene.destroy();

      this.sceneName = name;
      CN.settings.scene = name;
      this.scene = this.scenes[name](this);
      this.scene.resize(this.w, this.h);

      if (!silent) {
        this.fade = 1;
        this.ripples.length = 0;
      }
      CN.saveSettings();
      document.documentElement.dataset.scene = name;
      window.dispatchEvent(new CustomEvent('cn:scene', { detail: name }));
    }

    /* ---------------- 主循环 ---------------- */
    start() {
      if (this._raf) return;
      this.last = performance.now();
      const loop = (now) => {
        this._raf = requestAnimationFrame(loop);
        this._frame(now);
      };
      this._raf = requestAnimationFrame(loop);
    }

    _frame(now) {
      // dt：限制上限，避免切回标签页时爆炸
      let dt = (now - this.last) / 1000;
      this.last = now;
      if (dt > 0.08) dt = 0.08;
      if (dt < 0) dt = 0;
      this.dt = dt;
      this.wall += dt;

      // FPS 统计
      this._fpsAcc += dt;
      this._fpsFrames++;
      if (this._fpsAcc >= 0.5) {
        const f = this._fpsFrames / this._fpsAcc;
        this.fps = this.fps * 0.6 + f * 0.4;
        this._fpsAcc = 0;
        this._fpsFrames = 0;

        // 自适应：持续掉帧就降级
        if (this.fps < 40 && this.quality > 0.7) this.quality = 0.7;
        else if (this.fps > 56 && this.quality < 1) this.quality = 1;
      }

      const p = this.pointer;
      p.idle += dt;

      // 指针平滑（帧率无关阻尼）
      const k = U.damp(dt, 4.5);
      p.sx += (p.nx - p.sx) * k;
      p.sy += (p.ny - p.sy) * k;
      p.vx *= 0.9;
      p.vy *= 0.9;

      // 时间推进
      if (!CN.settings.paused) {
        this.t += dt * CN.settings.speed;
      }

      // 涟漪
      for (let i = this.ripples.length - 1; i >= 0; i--) {
        const r = this.ripples[i];
        r.age += dt;
        if (r.age > r.life) this.ripples.splice(i, 1);
      }

      this.fade = Math.max(0, this.fade - dt * 1.9);
      this.flash = Math.max(0, this.flash - dt * 3.2);

      if (document.hidden) return;

      this.render();

      if (this.onFrame) this.onFrame(this.dt);
    }

    render() {
      const ctx = this.ctx;
      const { w, h } = this;

      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';

      if (this.scene) {
        this.scene.update(this.dt, this.t);
        this.scene.draw(ctx);
      }

      this._post(ctx);

      // 场景切换遮罩
      if (this.fade > 0.001) {
        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = `rgba(3,1,8,${this.fade})`;
        ctx.fillRect(0, 0, w, h);
      }
    }

    /* ---------------- 后处理 ---------------- */
    _post(ctx) {
      const { w, h } = this;

      // ---- Bloom：两级缩放叠加，近似「亮度阈值 + 多尺度模糊」 ----
      const bOn = CN.settings.bloom && this.quality >= 1;
      if (bOn) {
        const a = this.bloomA, ac = this.bloomACtx;
        const b = this.bloomB, bc = this.bloomBCtx;

        ac.globalCompositeOperation = 'source-over';
        ac.clearRect(0, 0, a.width, a.height);
        ac.drawImage(this.canvas, 0, 0, a.width, a.height);

        bc.globalCompositeOperation = 'source-over';
        bc.clearRect(0, 0, b.width, b.height);
        bc.drawImage(a, 0, 0, b.width, b.height);

        ctx.globalCompositeOperation = 'lighter';
        const g = CN.settings.glow;
        ctx.globalAlpha = 0.26 * g;
        ctx.drawImage(a, 0, 0, w, h);
        ctx.globalAlpha = 0.20 * g;
        ctx.drawImage(b, 0, 0, w, h);
        ctx.globalAlpha = 1;
      }

      // ---- 扫描线 ----
      ctx.globalCompositeOperation = 'source-over';
      if (!this._scanPat) this._scanPat = ctx.createPattern(this.scanPattern, 'repeat');
      ctx.globalAlpha = 0.16;
      ctx.fillStyle = this._scanPat;
      ctx.fillRect(0, 0, w, h);
      ctx.globalAlpha = 1;

      // ---- 噪点（轻微，破带状渐变） ----
      ctx.globalAlpha = 0.028;
      const ox = (Math.random() * 160) | 0;
      const oy = (Math.random() * 160) | 0;
      if (!this._noisePat) this._noisePat = ctx.createPattern(this.noiseCanvas, 'repeat');
      ctx.save();
      ctx.translate(-ox, -oy);
      ctx.fillStyle = this._noisePat;
      ctx.fillRect(0, 0, w + 160, h + 160);
      ctx.restore();
      ctx.globalAlpha = 1;

      // ---- 暗角 ----
      if (!this._vignette) {
        const vg = ctx.createRadialGradient(
          w / 2, h / 2, Math.min(w, h) * 0.32,
          w / 2, h / 2, Math.max(w, h) * 0.78
        );
        vg.addColorStop(0, 'rgba(0,0,0,0)');
        vg.addColorStop(1, 'rgba(0,0,0,0.72)');
        this._vignette = vg;
      }
      ctx.fillStyle = this._vignette;
      ctx.fillRect(0, 0, w, h);

      // ---- 点击闪光 ----
      if (this.flash > 0.001 && this.ripples.length) {
        const r = this.ripples[this.ripples.length - 1];
        ctx.globalCompositeOperation = 'lighter';
        U.drawGlow(ctx, U.P.cyan, r.x, r.y, 420 * (1.2 - this.flash * 0.4), this.flash * 0.22, 0.5);
        ctx.globalCompositeOperation = 'source-over';
      }
    }

    /* ---------------- 通用：绘制涟漪环 ---------------- */
    drawRipples(ctx, color, scale = 1) {
      for (const r of this.ripples) {
        const k = r.age / r.life;
        const alpha = (1 - k) * (1 - k);
        if (alpha <= 0.01) continue;

        const rad = (40 + k * 460) * scale;
        ctx.globalCompositeOperation = 'lighter';

        ctx.beginPath();
        ctx.arc(r.x, r.y, rad, 0, U.TAU);
        ctx.strokeStyle = U.rgba(color, alpha * 0.55);
        ctx.lineWidth = 2.6 * (1 - k) + 0.4;
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(r.x, r.y, rad * 0.62, 0, U.TAU);
        ctx.strokeStyle = U.rgba(color, alpha * 0.22);
        ctx.lineWidth = 1.2;
        ctx.stroke();

        ctx.globalCompositeOperation = 'source-over';
      }
    }
  }

  CN.Engine = Engine;
})();
