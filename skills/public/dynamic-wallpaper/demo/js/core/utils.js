/* =========================================================
   CyberNeon · utils
   数学 / 颜色 / 预渲染贴图缓存
   ========================================================= */
window.CN = window.CN || {};

(function () {
  'use strict';

  const U = (CN.utils = {});

  /* ---------------- 数学 ---------------- */
  U.clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  U.lerp = (a, b, t) => a + (b - a) * t;
  U.rand = (a = 0, b = 1) => a + Math.random() * (b - a);
  U.randInt = (a, b) => Math.floor(a + Math.random() * (b - a + 1));
  U.pick = (arr) => arr[(Math.random() * arr.length) | 0];
  U.chance = (p) => Math.random() < p;
  U.TAU = Math.PI * 2;

  // 帧率无关的指数平滑：把「每秒衰减 k」换算成本帧系数
  U.damp = (dt, rate) => 1 - Math.exp(-rate * dt);

  // 平滑插值（帧率无关）
  U.approach = (cur, target, dt, rate) =>
    cur + (target - cur) * (1 - Math.exp(-rate * dt));

  // 确定性伪随机，用于生成稳定的城市纹理
  U.hash = function (n) {
    n = (n << 13) ^ n;
    return ((n * (n * n * 15731 + 789221) + 1376312589) & 0x7fffffff) / 0x7fffffff;
  };

  // 一维值噪声 + fbm
  U.noise1 = function (x, seed = 0) {
    const i = Math.floor(x);
    const f = x - i;
    const s = f * f * (3 - 2 * f);
    const a = U.hash(i * 374761393 + seed * 668265263);
    const b = U.hash((i + 1) * 374761393 + seed * 668265263);
    return a + (b - a) * s;
  };

  U.fbm1 = function (x, octaves = 3, seed = 0) {
    let v = 0, amp = 0.5, freq = 1;
    for (let i = 0; i < octaves; i++) {
      v += U.noise1(x * freq, seed + i * 31) * amp;
      freq *= 2;
      amp *= 0.5;
    }
    return v;
  };

  /* ---------------- 颜色 ---------------- */
  const hexCache = new Map();
  U.hexToRgb = function (hex) {
    if (hexCache.has(hex)) return hexCache.get(hex);
    let h = hex.replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    const n = parseInt(h, 16);
    const out = { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
    hexCache.set(hex, out);
    return out;
  };

  U.rgba = function (hex, a) {
    const c = U.hexToRgb(hex);
    return `rgba(${c.r},${c.g},${c.b},${a})`;
  };

  U.mixHex = function (h1, h2, t) {
    const a = U.hexToRgb(h1), b = U.hexToRgb(h2);
    const r = Math.round(U.lerp(a.r, b.r, t));
    const g = Math.round(U.lerp(a.g, b.g, t));
    const bl = Math.round(U.lerp(a.b, b.b, t));
    return `rgb(${r},${g},${bl})`;
  };

  // 调色板
  U.P = {
    cyan: '#00eaff',
    ice: '#7df9ff',
    magenta: '#ff2d78',
    pink: '#ff6ec7',
    purple: '#9b4dff',
    violet: '#c084fc',
    amber: '#ffb038',
    gold: '#ffd166',
    lime: '#8bff5e',
    red: '#ff3b3b',
    deep: '#05010d',
    ink: '#0a0418'
  };

  /* ---------------- 预渲染发光贴图 ---------------- */
  // 关键性能点：所有霓虹光点都用预渲染径向渐变贴图叠加，
  // 比 shadowBlur / filter:blur 快一到两个数量级。
  const glowCache = new Map();

  U.glowSprite = function (color, size = 128, hardness = 0.2) {
    const key = color + '|' + size + '|' + hardness;
    const hit = glowCache.get(key);
    if (hit) return hit;

    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d');
    const r = size / 2;
    const grd = g.createRadialGradient(r, r, 0, r, r, r);

    // 高斯衰减：避免出现「实心圆盘」的硬边界
    const sigma = U.clamp(hardness * 1.15, 0.06, 1.1);
    const STEPS = 14;
    for (let i = 0; i <= STEPS; i++) {
      const t = i / STEPS;
      const a = Math.exp(-(t * t) / (2 * sigma * sigma));
      grd.addColorStop(t, U.rgba(color, a));
    }
    grd.addColorStop(1, U.rgba(color, 0));

    g.fillStyle = grd;
    g.fillRect(0, 0, size, size);

    glowCache.set(key, c);
    return c;
  };

  // 在 (x,y) 处以 diameter 画一团光
  U.drawGlow = function (ctx, color, x, y, diameter, alpha = 1, hardness = 0.18) {
    if (alpha <= 0.004) return;
    const s = U.glowSprite(color, 128, hardness);
    const prev = ctx.globalAlpha;
    ctx.globalAlpha = prev * alpha;
    ctx.drawImage(s, x - diameter / 2, y - diameter / 2, diameter, diameter);
    ctx.globalAlpha = prev;
  };

  // 竖直拉长的光柱（地面倒影 / 灯带）
  U.drawStreak = function (ctx, color, x, y, w, h, alpha = 1) {
    const s = U.glowSprite(color, 128, 0.3);
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(w / 128, h / 128);
    ctx.globalAlpha *= alpha;
    ctx.drawImage(s, -64, -64);
    ctx.restore();
  };

  /* ---------------- 画布 ---------------- */
  U.makeCanvas = function (w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.ceil(w));
    c.height = Math.max(1, Math.ceil(h));
    return c;
  };

  // 竖直倒影贴图（1 色 × 竖向渐变），比每帧新建渐变快得多
  const reflCache = new Map();
  U.reflectSprite = function (color) {
    const hit = reflCache.get(color);
    if (hit) return hit;

    const c = U.makeCanvas(8, 128);
    const g = c.getContext('2d');
    const grd = g.createLinearGradient(0, 0, 0, 128);
    grd.addColorStop(0, U.rgba(color, 1));
    grd.addColorStop(0.30, U.rgba(color, 0.52));
    grd.addColorStop(0.68, U.rgba(color, 0.15));
    grd.addColorStop(1, U.rgba(color, 0));
    g.fillStyle = grd;
    g.fillRect(0, 0, 8, 128);

    reflCache.set(color, c);
    return c;
  };

  U.roundRect = function (ctx, x, y, w, h, r) {
    const rr = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  };

  /* ---------------- 其它 ---------------- */
  U.fmtHex = (n, len) => n.toString(16).toUpperCase().padStart(len, '0');

  // 十六进制数据流字符集
  U.GLYPHS = '0123456789ABCDEF<>/\\|=+*#$%@&░▒▓'.split('');

  // 伪日文/中文招牌词（壁纸用，纯装饰）
  U.SIGNS = [
    '電脳街', '霓虹', 'ラーメン', 'NEON', 'SYNTH', '数据港', '自動義体',
    '24H', 'CYBER', '神经链', 'ホテル', 'ANDROID', '燃料', 'NIGHT CITY',
    '義眼', 'BAR', '量子', 'VOID', '电子羊', 'PLASMA'
  ];
})();
