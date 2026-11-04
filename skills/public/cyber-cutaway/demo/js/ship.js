/* =========================================================
   CyberJet · 机体程序化建模
   机身：超椭圆截面 loft（上下分半，可剖开）
   机翼：NACA 四位数翼型沿展向放样
   内部：隔框 / 纵梁 / 地板 / 座椅阵列 / 航电架 / 低温罐 / 导管
   ========================================================= */
(function () {
  'use strict';

  const T = THREE;
  const CJ = window.CJ;

  const SEG = 96;        // 机身纵向分段
  const SIDES = 28;      // 每圈点数（偶数）
  const HALF = SIDES / 2;

  const P = (x, y, z) => new T.Vector3(x, y, z);

  /* ---------------- 工具 ---------------- */
  function cr(p0, p1, p2, p3, t) {
    const t2 = t * t, t3 = t2 * t;
    return 0.5 * ((2 * p1) + (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
  }

  // t ∈ [0,1]：0 = 机头，1 = 机尾
  function profileAt(t) {
    const A = CJ.PROFILE, n = A.length - 1;
    const f = T.MathUtils.clamp(t, 0, 1) * n;
    const i = Math.min(n - 1, Math.floor(f));
    const lt = f - i;
    const row = (k) => A[T.MathUtils.clamp(k, 0, n)];
    const out = [];
    for (let c = 0; c < 5; c++) {
      out[c] = cr(row(i - 1)[c], row(i)[c], row(i + 1)[c], row(i + 2)[c], lt);
    }
    return { x: out[0], w: out[1], ht: out[2], hb: out[3], n: out[4] };
  }

  // 超椭圆上的点：θ=0 → +Z，θ=π/2 → +Y
  function shellPoint(pr, theta, inset) {
    const k = 1 - (inset || 0);
    const e = 2 / pr.n;
    const c = Math.cos(theta), s = Math.sin(theta);
    const z = Math.sign(c) * Math.pow(Math.abs(c), e) * pr.w * k;
    const h = (s >= 0 ? pr.ht : pr.hb) * k;
    const y = Math.sign(s) * Math.pow(Math.abs(s), e) * h;
    return P(pr.x, y, z);
  }

  // 按纵向坐标 x 反查剖面（x 随 t 单调递减，二分）
  function prAtX(x) {
    if (x >= profileAt(0).x) return profileAt(0);
    if (x <= profileAt(1).x) return profileAt(1);
    let lo = 0, hi = 1;
    for (let i = 0; i < 40; i++) {
      const m = (lo + hi) * 0.5;
      if (profileAt(m).x > x) lo = m; else hi = m;
    }
    return profileAt((lo + hi) * 0.5);
  }

  /* 供 interior.js 复用 */
  CJ.profileAt = profileAt;
  CJ.shellPoint = shellPoint;
  CJ.prAtX = prAtX;
  CJ.P = P;

  /* ---------------- 轮廓光（Fresnel 边缘发光） ---------------- */
  function rimMaterial(color, power, strength) {
    return new T.ShaderMaterial({
      uniforms: {
        uColor: { value: new T.Color(color) },
        uPower: { value: power },
        uStr: { value: strength === undefined ? 1 : strength }
      },
      vertexShader: [
        'varying vec3 vN;',
        'varying vec3 vV;',
        'void main() {',
        '  vec4 mv = modelViewMatrix * vec4(position, 1.0);',
        '  vN = normalize(normalMatrix * normal);',
        '  vV = normalize(-mv.xyz);',
        '  gl_Position = projectionMatrix * mv;',
        '}'
      ].join('\n'),
      fragmentShader: [
        'uniform vec3 uColor;',
        'uniform float uPower;',
        'uniform float uStr;',
        'varying vec3 vN;',
        'varying vec3 vV;',
        'void main() {',
        '  float f = 1.0 - clamp(dot(normalize(vN), normalize(vV)), 0.0, 1.0);',
        '  f = pow(f, uPower) * uStr;',
        '  gl_FragColor = vec4(uColor * f, f);',
        '}'
      ].join('\n'),
      transparent: true,
      blending: T.AdditiveBlending,
      depthWrite: false,
      side: T.FrontSide
    });
  }

  /* ---------------- 蒙皮贴花（面板分割 / 编号 / 警示条） ----------------
     同时产出颜色图与凹凸图：只有颜色没有凹凸，面板线就"印"在塑料上。 */
  function hullTextures() {
    const W = 1024, H = 512;
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const cg = cv.getContext('2d');
    const bv = document.createElement('canvas'); bv.width = W; bv.height = H;
    const bg = bv.getContext('2d');

    // 凹凸底色 = 平面
    bg.fillStyle = '#808080'; bg.fillRect(0, 0, W, H);

    // 颜色底色：冷灰金属
    cg.fillStyle = '#4c5866'; cg.fillRect(0, 0, W, H);

    /* --- 拼板：不同反射率的面板 --- */
    const PX = 8, PY = 6;
    const cw = W / PX, ch = H / PY;
    for (let iy = 0; iy < PY; iy++) {
      for (let ix = 0; ix < PX; ix++) {
        const seed = (ix * 37 + iy * 91 + ix * iy * 13) % 100;
        const c = seed < 26 ? '#5b6875' : seed < 52 ? '#49545f' : seed < 74 ? '#535f6c' : '#3f4a55';
        cg.fillStyle = c;
        cg.fillRect(ix * cw + 1, iy * ch + 1, cw - 2, ch - 2);
        // 每块板自身的细微明暗
        const g2 = cg.createLinearGradient(ix * cw, iy * ch, ix * cw + cw, iy * ch + ch);
        g2.addColorStop(0, 'rgba(255,255,255,' + (0.02 + (seed % 7) * 0.006) + ')');
        g2.addColorStop(1, 'rgba(0,0,0,0.10)');
        cg.fillStyle = g2;
        cg.fillRect(ix * cw + 1, iy * ch + 1, cw - 2, ch - 2);

        // 凹凸：板面略高，缝隙低
        bg.fillStyle = seed % 3 === 0 ? '#8c8c8c' : '#848484';
        bg.fillRect(ix * cw + 2, iy * ch + 2, cw - 4, ch - 4);
      }
    }

    /* --- 缝隙 --- */
    const seam = (g, style, w) => {
      g.strokeStyle = style; g.lineWidth = w;
      for (let ix = 0; ix <= PX; ix++) {
        g.beginPath(); g.moveTo(ix * cw, 0); g.lineTo(ix * cw, H); g.stroke();
      }
      for (let iy = 0; iy <= PY; iy++) {
        g.beginPath(); g.moveTo(0, iy * ch); g.lineTo(W, iy * ch); g.stroke();
      }
    };
    seam(cg, 'rgba(6,10,14,0.95)', 2.4);
    seam(cg, 'rgba(120,200,230,0.16)', 1.0);
    seam(bg, '#3a3a3a', 3.0);

    /* --- 次级分割线（每块板内部再切一刀） --- */
    cg.strokeStyle = 'rgba(10,16,22,0.8)'; cg.lineWidth = 1.2;
    bg.strokeStyle = '#5c5c5c'; bg.lineWidth = 1.6;
    for (let iy = 0; iy < PY; iy++) {
      for (let ix = 0; ix < PX; ix++) {
        if ((ix + iy) % 2) continue;
        const x = ix * cw + cw * 0.5;
        [cg, bg].forEach((g) => {
          g.beginPath(); g.moveTo(x, iy * ch); g.lineTo(x, iy * ch + ch); g.stroke();
        });
      }
    }

    /* --- 铆钉 --- */
    for (let ix = 0; ix <= PX; ix++) {
      for (let iy = 0; iy <= PY; iy++) {
        for (let k = 1; k < 8; k++) {
          const rx = ix * cw, ry = iy * ch + ch * k / 8;
          cg.fillStyle = 'rgba(150,195,215,0.22)';
          cg.beginPath(); cg.arc(rx, ry, 1.6, 0, 6.283); cg.fill();
          bg.fillStyle = '#9a9a9a';
          bg.beginPath(); bg.arc(rx, ry, 2.0, 0, 6.283); bg.fill();
        }
      }
    }

    /* --- 检修口 --- */
    [[182, 96], [640, 300], [860, 130], [392, 420], [96, 380]].forEach(([x, y], i) => {
      const r = 30 + (i % 2) * 8;
      cg.strokeStyle = 'rgba(8,14,20,0.9)'; cg.lineWidth = 3;
      cg.beginPath(); cg.arc(x, y, r, 0, 6.283); cg.stroke();
      bg.strokeStyle = '#4a4a4a'; bg.lineWidth = 4;
      bg.beginPath(); bg.arc(x, y, r, 0, 6.283); bg.stroke();
      cg.strokeStyle = 'rgba(140,210,235,0.45)'; cg.lineWidth = 1.2;
      cg.beginPath(); cg.arc(x, y, r - 3, 0, 6.283); cg.stroke();
      // 十字锁扣
      cg.strokeStyle = 'rgba(150,215,240,0.5)'; cg.lineWidth = 2;
      cg.beginPath();
      cg.moveTo(x - 9, y); cg.lineTo(x + 9, y);
      cg.moveTo(x, y - 9); cg.lineTo(x, y + 9);
      cg.stroke();
    });

    /* --- 警示条 --- */
    [[70, 236, 210, 20], [690, 58, 240, 20], [300, 470, 170, 16]].forEach(([x, y, w, h]) => {
      cg.save();
      cg.beginPath(); cg.rect(x, y, w, h); cg.clip();
      cg.fillStyle = '#b8912a'; cg.fillRect(x, y, w, h);
      cg.fillStyle = '#0d1319';
      for (let i = -h; i < w + h; i += 20) {
        cg.beginPath();
        cg.moveTo(x + i, y + h); cg.lineTo(x + i + h, y);
        cg.lineTo(x + i + h + 9, y); cg.lineTo(x + i + 9, y + h);
        cg.closePath(); cg.fill();
      }
      cg.restore();
    });

    /* --- 编号 --- */
    cg.fillStyle = 'rgba(196,232,246,0.72)';
    cg.font = '700 38px monospace';
    cg.fillText('EV-07', 486, 168);
    cg.font = '500 15px monospace';
    cg.fillStyle = 'rgba(150,200,222,0.55)';
    cg.fillText('STRUCTURAL ACCESS · AUTHORIZED ONLY', 486, 194);
    cg.fillText('P-04 / SEG 02', 128, 470);
    cg.fillText('NO STEP', 840, 236);

    /* --- 磨损 / 污渍 --- */
    for (let i = 0; i < 260; i++) {
      const x = Math.random() * W, y = Math.random() * H;
      const w = 8 + Math.random() * 90, h = 2 + Math.random() * 16;
      cg.fillStyle = 'rgba(' + (Math.random() < 0.5 ? '0,0,0' : '120,160,180') +
        ',' + (0.02 + Math.random() * 0.05) + ')';
      cg.fillRect(x, y, w, h);
    }

    const mk = (canvas, srgb) => {
      const t = new T.CanvasTexture(canvas);
      if (srgb && T.sRGBEncoding) t.encoding = T.sRGBEncoding;
      t.wrapS = t.wrapT = T.RepeatWrapping;
      t.repeat.set(1, 3);
      t.anisotropy = 4;
      return t;
    };
    return { map: mk(cv, true), bump: mk(bv, false) };
  }

  /* ---------------- 机身蒙皮（半壳 loft） ---------------- */
  function buildHalfShell(upper, inset) {
    const cols = HALF + 1;
    const pos = new Float32Array((SEG + 1) * cols * 3);
    const uvs = new Float32Array((SEG + 1) * cols * 2);
    let k = 0, ku = 0;

    for (let i = 0; i <= SEG; i++) {
      const t = i / SEG;
      const pr = profileAt(t);
      for (let j = 0; j <= HALF; j++) {
        // upper: θ 0→π ；lower: θ π→2π
        const theta = upper
          ? (j / HALF) * Math.PI
          : Math.PI + (j / HALF) * Math.PI;
        const v = shellPoint(pr, theta, inset);
        pos[k++] = v.x; pos[k++] = v.y; pos[k++] = v.z;
        uvs[ku++] = j / HALF;
        uvs[ku++] = t;
      }
    }

    const idx = [];
    for (let i = 0; i < SEG; i++) {
      for (let j = 0; j < HALF; j++) {
        const a = i * cols + j;
        const b = a + 1;
        const c = a + cols;
        const d = c + 1;
        idx.push(a, b, c, b, d, c);
      }
    }

    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(pos, 3));
    g.setAttribute('uv', new T.BufferAttribute(uvs, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }
  CJ.buildHalfShell = buildHalfShell;

  // 面板分割线（沿环向 / 纵向），营造蒙皮拼版感
  function buildPanelLines(upper) {
    const pts = [];
    const push = (p, q) => { pts.push(p.x, p.y, p.z, q.x, q.y, q.z); };

    for (let i = 0; i <= SEG; i += 4) {
      const pr = profileAt(i / SEG);
      const pr2 = profileAt(Math.min(1, i / SEG + 0.0001));
      for (let j = 0; j < HALF; j++) {
        const t0 = upper ? (j / HALF) * Math.PI : Math.PI + (j / HALF) * Math.PI;
        const t1 = upper ? ((j + 1) / HALF) * Math.PI : Math.PI + ((j + 1) / HALF) * Math.PI;
        push(shellPoint(pr2, t0, 0.002), shellPoint(pr2, t1, 0.002));
      }
    }
    for (let j = 1; j < HALF; j += 2) {
      const theta = upper ? (j / HALF) * Math.PI : Math.PI + (j / HALF) * Math.PI;
      for (let i = 0; i < SEG; i++) {
        const a = profileAt(i / SEG);
        const b = profileAt((i + 1) / SEG);
        push(shellPoint(a, theta, 0.002), shellPoint(b, theta, 0.002));
      }
    }

    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(pts, 3));
    return new T.LineSegments(g, new T.LineBasicMaterial({
      color: 0x4fe4f5, transparent: true, opacity: 0.12, depthWrite: false
    }));
  }

  /* ---------------- 切口封边 ----------------
     剖开后的断面不能只是"两层壳的毛边"。这里给切面补一条有厚度的板边：
     外缘高热青、向内迅速变暗 —— 读起来就是"被切开的复合板"，
     也顺手把上下两个半壳的轮廓钉住。 */
  function sectionTexture() {
    const c = document.createElement('canvas');
    c.width = 8; c.height = 128;
    const g = c.getContext('2d');
    const grd = g.createLinearGradient(0, 0, 0, 128);
    grd.addColorStop(0.00, '#c9f7ff');
    grd.addColorStop(0.05, '#4fd6f0');
    grd.addColorStop(0.14, '#1891ad');
    grd.addColorStop(0.40, '#0a3341');
    grd.addColorStop(1.00, '#050f15');
    g.fillStyle = grd;
    g.fillRect(0, 0, 8, 128);
    const t = new T.CanvasTexture(c);
    if (T.sRGBEncoding) t.encoding = T.sRGBEncoding;
    t.wrapS = t.wrapT = T.ClampToEdgeWrapping;
    return t;
  }

  function buildSection(side, tex) {
    const theta = side > 0 ? 0 : Math.PI;
    const pos = [], uv = [], idx = [];
    const iA = -0.006, iB = 0.088;
    for (let i = 0; i <= SEG; i++) {
      const t = i / SEG;
      const pr = profileAt(t);
      const a = shellPoint(pr, theta, iA);
      const b = shellPoint(pr, theta, iB);
      pos.push(a.x, a.y, a.z, b.x, b.y, b.z);
      uv.push(t, 1, t, 0);
    }
    for (let i = 0; i < SEG; i++) {
      const A = i * 2, B = A + 2;
      idx.push(A, B, A + 1, A + 1, B, B + 1);
    }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new T.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    return new T.Mesh(g, new T.MeshBasicMaterial({
      map: tex, side: T.DoubleSide, toneMapped: false,
      transparent: true, opacity: 0.95
    }));
  }

  /* ---------------- 座舱盖 ---------------- */
  function buildCanopy() {
    const x0 = 8.35, x1 = 10.95, cols = 15, rows = 9;
    const pos = [];
    for (let i = 0; i <= rows; i++) {
      const x = T.MathUtils.lerp(x0, x1, i / rows);
      // 反查该 x 处的轮廓
      let pr = profileAt(0.5);
      for (let s = 0; s <= 200; s++) {
        const p = profileAt(s / 200);
        if (p.x <= x) { pr = p; break; }
      }
      for (let j = 0; j <= cols; j++) {
        const theta = Math.PI * 0.30 + (j / cols) * Math.PI * 0.40;
        const v = shellPoint(pr, theta, -0.006);
        pos.push(v.x, v.y, v.z);
      }
    }
    const idx = [];
    const cw = cols + 1;
    for (let i = 0; i < rows; i++) {
      for (let j = 0; j < cols; j++) {
        const a = i * cw + j, b = a + 1, c = a + cw, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }

  /* ---------------- 翼面放样 ---------------- */
  function airfoilY(u, thick) {
    const s = Math.sqrt(Math.max(0, u));
    return 5 * thick * (0.2969 * s - 0.126 * u - 0.3516 * u * u +
      0.2843 * u * u * u - 0.1015 * u * u * u * u);
  }

  // place(s, u, side) → 世界坐标；s 沿展向 0..1，u 沿弦向 0..1，side ±1 上下表面
  function buildAirfoil(place, spanSeg, asym) {
    const AF = 20;
    const cols = AF + 1;
    const pos = [];
    for (let i = 0; i <= spanSeg; i++) {
      const s = i / spanSeg;
      for (let j = 0; j <= AF; j++) {
        // 前后缘闭合：j 0..AF/2 上表面，其余下表面
        const half = AF / 2;
        const u = j <= half ? j / half : (AF - j) / half;
        const side = j <= half ? 1 : -1;
        const v = place(s, u, side);
        pos.push(v.x, v.y, v.z);
      }
    }
    const idx = [];
    for (let i = 0; i < spanSeg; i++) {
      for (let j = 0; j < AF; j++) {
        const a = i * cols + j, b = a + 1, c = a + cols, d = c + 1;
        idx.push(a, b, c, b, d, c);
      }
    }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }

  function flipIndex(g) {
    const a = g.index.array;
    for (let i = 0; i < a.length; i += 3) {
      const t = a[i + 1]; a[i + 1] = a[i + 2]; a[i + 2] = t;
    }
    g.index.needsUpdate = true;
    g.computeVertexNormals();
    return g;
  }

  function makeWing(sign, mat) {
    const rootX = 3.05, span = 6.15, sweep = 2.55, dihedral = 0.16;
    const chordR = 4.35, chordT = 1.55, thR = 0.175, thT = 0.085;

    const place = (s, u, side) => {
      const chord = T.MathUtils.lerp(chordR, chordT, s);
      const le = rootX - sweep * Math.pow(s, 0.95);
      const x = le - u * chord;
      const camber = 0.028 * chord * Math.sin(Math.PI * u);
      const y = -0.16 + dihedral * s * s * 0.9 + camber + side * airfoilY(u, T.MathUtils.lerp(thR, thT, s)) * chord;
      const z = sign * (1.52 + s * span);
      return P(x, y, z);
    };

    const g = buildAirfoil(place, 22);
    if (sign < 0) flipIndex(g);
    const grp = new T.Group();
    grp.add(new T.Mesh(g, mat));
    grp.add(new T.Mesh(g, rimMaterial(0x6ff4ff, 3.6, 0.32)));

    /* 翼面分割线：没有这几根线，机翼就是一块塑料片 */
    const pts = [];
    const pushLine = (u0, side) => {
      for (let i = 0; i < 22; i++) {
        const a = place(i / 22, u0, side);
        const b = place((i + 1) / 22, u0, side);
        pts.push(a.x, a.y, a.z, b.x, b.y, b.z);
      }
    };
    pushLine(0.02, 1); pushLine(0.985, 1);
    [0.16, 0.34, 0.55, 0.78].forEach((u) => pushLine(u, 1));
    for (let i = 0; i < 22; i += 4) {
      const s0 = i / 22, s1 = (i + 4) / 22;
      [0.04, 0.5, 0.97].forEach((u) => {
        const a = place(s0, u, 1), b = place(s1, u, 1);
        pts.push(a.x, a.y, a.z, b.x, b.y, b.z);
      });
    }
    const lg = new T.BufferGeometry();
    lg.setAttribute('position', new T.Float32BufferAttribute(pts, 3));
    grp.add(new T.LineSegments(lg, new T.LineBasicMaterial({
      color: 0x63dcf0, transparent: true, opacity: 0.45, depthWrite: false
    })));

    grp.userData.partId = 'wing';
    return grp;
  }

  function makeFin(sign, mat) {
    const rootX = -6.35, span = 2.7, sweep = 1.8;
    const chordR = 3.2, chordT = 1.15, thR = 0.15, thT = 0.075;
    const tilt = 0.46;

    const place = (s, u, side) => {
      const chord = T.MathUtils.lerp(chordR, chordT, s);
      const le = rootX - sweep * s;
      const x = le - u * chord;
      const y = 0.60 + s * span * Math.cos(tilt);
      const z = sign * (0.95 + s * span * Math.sin(tilt));
      const off = side * airfoilY(u, T.MathUtils.lerp(thR, thT, s)) * chord;
      return P(x + off * Math.sin(tilt), y + off * Math.cos(tilt), z + off * 0);
    };

    const g = buildAirfoil(place, 14);
    if (sign < 0) flipIndex(g);
    return new T.Mesh(g, mat);
  }

  /* ---------------- 引擎 ---------------- */
  function makeEngine(pos, scale, mats, sign) {
    const g = new T.Group();
    g.position.copy(pos);
    g.scale.setScalar(scale);

    // 外壳
    const shell = new T.Mesh(new T.CylinderGeometry(0.44, 0.52, 2.5, 22, 1, true), mats.engineShell);
    shell.rotation.z = Math.PI / 2;
    g.add(shell);

    // 进气唇
    const lip = new T.Mesh(new T.TorusGeometry(0.44, 0.045, 8, 24), mats.neon);
    lip.rotation.y = Math.PI / 2;
    lip.position.x = 1.25;
    g.add(lip);

    // 压气机面
    const fan = new T.Mesh(new T.CircleGeometry(0.41, 20), mats.engineCore);
    fan.rotation.y = Math.PI / 2;
    fan.position.x = 1.24;
    g.add(fan);

    // 尾喷
    const nozzle = new T.Mesh(new T.CylinderGeometry(0.34, 0.44, 0.55, 20, 1, true), mats.engineShell);
    nozzle.rotation.z = Math.PI / 2;
    nozzle.position.x = -1.5;
    g.add(nozzle);

    const glow = new T.Mesh(new T.CircleGeometry(0.33, 20), mats.plume);
    glow.rotation.y = -Math.PI / 2;
    glow.position.x = -1.74;
    g.add(glow);

    // 挂架
    const pylon = new T.Mesh(new T.BoxGeometry(0.9, 0.5, 0.14), mats.hullDark);
    pylon.position.set(0.2, 0.5, 0);
    g.add(pylon);

    g.userData.plume = glow;
    return g;
  }

  /* ---------------- 起落架 ---------------- */
  function makeGear(mats, wheelPos, strutTop, wide) {
    const g = new T.Group();
    const drop = strutTop.y - wheelPos.y;

    const strut = new T.Mesh(new T.CylinderGeometry(0.085, 0.105, drop, 10), mats.metal);
    strut.position.set(wheelPos.x, strutTop.y - drop / 2, wheelPos.z);
    g.add(strut);

    const r = wide ? 0.46 : 0.34;
    const wr = wide ? 0.26 : 0.2;
    const n = wide ? 2 : 1;
    for (let i = 0; i < n; i++) {
      const off = n === 1 ? 0 : (i === 0 ? -0.22 : 0.22);
      const w = new T.Mesh(new T.CylinderGeometry(r, r, wr, 18), mats.rubber);
      w.rotation.x = Math.PI / 2;
      w.position.set(wheelPos.x, wheelPos.y + r * 0.0, wheelPos.z + off);
      g.add(w);
      const hub = new T.Mesh(new T.CylinderGeometry(r * 0.42, r * 0.42, wr + 0.02, 12), mats.metal);
      hub.rotation.x = Math.PI / 2;
      hub.position.set(wheelPos.x, wheelPos.y, wheelPos.z + off);
      g.add(hub);
    }
    return g;
  }

  /* ---------------- 汇总 ---------------- */
  CJ.buildShip = function () {
    const htx = hullTextures();

    const mats = {
      /* 蒙皮：复合装甲板。物理材质 + 凹凸，让它吃光而不是"发白" */
      hullShell: new T.MeshPhysicalMaterial({
        color: 0xd2dde8, map: htx.map, bumpMap: htx.bump, bumpScale: 0.05,
        metalness: 0.88, roughness: 0.48,
        clearcoat: 0.4, clearcoatRoughness: 0.45,
        envMapIntensity: 1.5,
        emissive: 0x050a10, emissiveIntensity: 1
      }),
      hullWing: new T.MeshPhysicalMaterial({
        color: 0x39455a, metalness: 0.86, roughness: 0.62, side: T.DoubleSide,
        clearcoat: 0.3, clearcoatRoughness: 0.55,
        envMapIntensity: 1.15,
        emissive: 0x03080e, emissiveIntensity: 1
      }),
      hullDark: new T.MeshStandardMaterial({ color: 0x0c1219, metalness: 0.85, roughness: 0.5 }),
      metal: new T.MeshStandardMaterial({ color: 0x6a7686, metalness: 0.95, roughness: 0.28 }),
      rubber: new T.MeshStandardMaterial({ color: 0x0a0d12, metalness: 0.3, roughness: 0.9 }),
      glass: new T.MeshPhysicalMaterial({
        color: 0x1a6f8c, metalness: 0.05, roughness: 0.04,
        transparent: true, opacity: 0.22, side: T.DoubleSide,
        clearcoat: 1, clearcoatRoughness: 0.02,
        envMapIntensity: 2.2,
        emissive: 0x0a3348, emissiveIntensity: 1.2
      }),

      /* ---- 内部结构件 ---- */
      liner: new T.MeshStandardMaterial({
        map: CJ.linerTexture(), bumpMap: CJ.linerTexture(true), bumpScale: 0.03,
        color: 0xdfe9f2, metalness: 0.12, roughness: 0.94,
        emissive: 0x060d14, emissiveIntensity: 1
      }),
      frame: new T.MeshStandardMaterial({
        color: 0x202a35, metalness: 0.35, roughness: 0.62,
        envMapIntensity: 0.4, flatShading: true,
        emissive: 0x02090f, emissiveIntensity: 1, side: T.DoubleSide
      }),
      frameHot: new T.MeshStandardMaterial({
        color: 0x2f4a60, metalness: 0.45, roughness: 0.5,
        envMapIntensity: 0.5, flatShading: true,
        emissive: 0x0b4a60, emissiveIntensity: 1.5, side: T.DoubleSide
      }),
      floor: new T.MeshStandardMaterial({
        color: 0x1e2632, metalness: 0.5, roughness: 0.66,
        envMapIntensity: 0.5, flatShading: false,
        emissive: 0x060f16, emissiveIntensity: 1
      }),
      seamDark: new T.MeshStandardMaterial({ color: 0x080d13, metalness: 0.4, roughness: 0.8 }),
      beam: new T.MeshStandardMaterial({
        color: 0x333d4a, metalness: 0.8, roughness: 0.48,
        envMapIntensity: 0.55, flatShading: true
      }),
      seat: new T.MeshStandardMaterial({
        color: 0x232c44, metalness: 0.35, roughness: 0.66,
        envMapIntensity: 0.5,
        emissive: 0x081228, emissiveIntensity: 1
      }),
      seatHot: new T.MeshStandardMaterial({
        color: 0x2e3a5e, metalness: 0.4, roughness: 0.55,
        envMapIntensity: 0.5,
        emissive: 0x0d2c4c, emissiveIntensity: 1
      }),
      rack: new T.MeshStandardMaterial({
        color: 0x1a242e, metalness: 0.7, roughness: 0.5, envMapIntensity: 0.5,
        emissive: 0x051d1a, emissiveIntensity: 1
      }),
      tank: new T.MeshPhysicalMaterial({
        color: 0x5a6280, metalness: 0.9, roughness: 0.22,
        clearcoat: 0.8, clearcoatRoughness: 0.2, envMapIntensity: 1.6,
        emissive: 0x1a0f3a, emissiveIntensity: 0.9
      }),
      tankBand: new T.MeshStandardMaterial({
        color: 0x8b7ac0, metalness: 0.85, roughness: 0.35,
        emissive: 0x2a1060, emissiveIntensity: 1.1
      }),
      cargo: new T.MeshStandardMaterial({
        color: 0x3a3126, metalness: 0.6, roughness: 0.62,
        emissive: 0x1a1004, emissiveIntensity: 1
      }),
      cable: new T.MeshStandardMaterial({ color: 0x2a2f3a, metalness: 0.55, roughness: 0.6 }),
      wire: new T.MeshStandardMaterial({ color: 0x7a5a3a, metalness: 0.8, roughness: 0.4 }),
      conduit: new T.MeshStandardMaterial({
        color: 0x8a6a30, metalness: 0.92, roughness: 0.32,
        emissive: 0x4a2c04, emissiveIntensity: 1.15
      }),
      coreShell: new T.MeshBasicMaterial({
        color: 0xd8f6ff, transparent: true, opacity: 0.92, toneMapped: false
      }),
      coreRing: new T.MeshStandardMaterial({
        color: 0xff5a90, metalness: 0.7, roughness: 0.3,
        emissive: 0xff2d78, emissiveIntensity: 2.2
      }),
      coreCage: new T.MeshStandardMaterial({
        color: 0x3b4653, metalness: 0.88, roughness: 0.44,
        envMapIntensity: 0.6, flatShading: true,
        emissive: 0x0a2030, emissiveIntensity: 1
      }),
      led: new T.MeshBasicMaterial({ color: 0x7ff2ff, toneMapped: false }),
      ledAmber: new T.MeshBasicMaterial({ color: 0xffb547, toneMapped: false }),

      /* ---- 外部件 ---- */
      engineShell: new T.MeshStandardMaterial({
        color: 0x2c3744, metalness: 0.95, roughness: 0.26,
        side: T.DoubleSide, envMapIntensity: 1.4
      }),
      engineCore: new T.MeshBasicMaterial({ color: 0x0b1a22 }),
      neon: new T.MeshBasicMaterial({ color: 0x8ff8ff, toneMapped: false }),
      neonDim: new T.MeshBasicMaterial({ color: 0x2a7f96, toneMapped: false }),
      plume: new T.MeshBasicMaterial({
        color: 0xff3d7f, transparent: true, opacity: 0.85,
        blending: T.AdditiveBlending, depthWrite: false, toneMapped: false
      })
    };
    mats.section = sectionTexture();

    // 上盖必须能单独淡出：它抬起来之后如果还是实心板，内部永远看不见
    mats.hullShellUp = mats.hullShell.clone();
    mats.hullShellUp.transparent = true;
    mats.hullShellUp.opacity = 1;
    mats.linerUp = mats.liner.clone();
    mats.linerUp.transparent = true;
    mats.linerUp.opacity = 1;

    const root = new T.Group();
    const parts = {};

    /* ---- 蒙皮：上下两半 ---- */
    const upper = new T.Mesh(buildHalfShell(true, 0), mats.hullShellUp);
    const lower = new T.Mesh(buildHalfShell(false, 0), mats.hullShell);
    upper.userData.partId = 'hull';
    lower.userData.partId = 'hull';

    const rimUp = new T.Mesh(upper.geometry, rimMaterial(0x5ef2ff, 4.4, 0.30));
    const rimLo = new T.Mesh(lower.geometry, rimMaterial(0x5ef2ff, 4.4, 0.30));
    rimUp.userData.partId = 'hull';
    rimLo.userData.partId = 'hull';

    const linesUp = buildPanelLines(true);
    const linesLo = buildPanelLines(false);

    const upperGroup = new T.Group();
    const lowerGroup = new T.Group();
    // 板边断面：上下两半各带自己的一圈，剖开后才看得到"材料厚度"
    const secUpL = buildSection(-1, mats.section);
    const secUpR = buildSection(1, mats.section);
    const secLoL = buildSection(-1, mats.section);
    const secLoR = buildSection(1, mats.section);
    upperGroup.add(upper, rimUp, linesUp, secUpL, secUpR);
    lowerGroup.add(lower, rimLo, linesLo, secLoL, secLoR);
    root.add(upperGroup, lowerGroup);

    /* ---- 侧身发光带 ---- */
    for (const sign of [-1, 1]) {
      const strip = new T.Mesh(new T.BoxGeometry(11.5, 0.018, 0.018), mats.neonDim);
      strip.position.set(1.0, 0.02, sign * 1.615);
      strip.lookAt(1.2, 0.18, sign * 10);
      root.add(strip);
    }

    /* ---- 背脊棱线 ---- */
    {
      const spinePts = [];
      for (let i = 0; i <= 40; i++) {
        const t = 0.10 + (i / 40) * 0.72;
        const pr = profileAt(t);
        spinePts.push(P(pr.x, pr.ht + 0.005, 0));
      }
      const curve = new T.CatmullRomCurve3(spinePts);
      root.add(new T.Mesh(new T.TubeGeometry(curve, 60, 0.026, 5, false), mats.neonDim));
    }

    /* ---- 座舱盖 ---- */
    const canopy = new T.Mesh(buildCanopy(), mats.glass);
    canopy.userData.partId = 'cockpit';
    root.add(canopy);

    // 座舱内：仪表光
    const hudGlow = new T.Mesh(new T.PlaneGeometry(1.5, 0.5), new T.MeshBasicMaterial({
      color: 0x2ad0ff, transparent: true, opacity: 0.35,
      blending: T.AdditiveBlending, depthWrite: false, side: T.DoubleSide
    }));
    hudGlow.position.set(9.7, 0.28, 0);
    hudGlow.rotation.y = Math.PI / 2;
    root.add(hudGlow);

    /* ---- 机翼 ---- */
    const wings = new T.Group();
    for (const sign of [-1, 1]) {
      const w = makeWing(sign, mats.hullWing);
      w.userData.partId = 'wing';
      wings.add(w);
      // 翼尖航行灯
      const tip = new T.Mesh(new T.SphereGeometry(0.085, 8, 8), mats.neon);
      tip.position.set(0.1, 0.16, sign * 7.62);
      wings.add(tip);
    }
    root.add(wings);

    // 机翼在俯视时会整块挡住机身内部 —— 剖开时让它们退成幽灵
    const wingFade = [];
    wings.traverse((o) => { if (o.material) wingFade.push(o.material); });

    /* ---- 尾翼 ---- */
    const fins = new T.Group();
    for (const sign of [-1, 1]) {
      const f = makeFin(sign, mats.hullWing);
      f.userData.partId = 'wing';
      fins.add(f);
    }
    root.add(fins);
    fins.traverse((o) => { if (o.material) wingFade.push(o.material); });

    /* ---- 引擎 ---- */
    const engines = new T.Group();
    const engineList = [
      { p: P(1.62, -0.96, 3.30), s: 1.0 },
      { p: P(1.62, -0.96, -3.30), s: 1.0 },
      { p: P(-5.75, 0.34, 1.30), s: 0.74 },
      { p: P(-5.55, 0.30, -1.15), s: 0.82 }
    ];
    for (const e of engineList) {
      const eng = makeEngine(e.p, e.s, mats, 0);
      eng.traverse((o) => { if (o.isMesh) o.userData.partId = 'engine'; });
      engines.add(eng);
    }
    root.add(engines);

    /* ---- 起落架 ---- */
    const gear = new T.Group();
    const g1 = makeGear(mats, P(8.55, -2.35, 0), P(8.55, -1.05, 0), false);
    const g2 = makeGear(mats, P(-0.9, -2.45, 1.65), P(-0.9, -1.1, 1.55), true);
    const g3 = makeGear(mats, P(-0.9, -2.45, -1.65), P(-0.9, -1.1, -1.55), true);
    [g1, g2, g3].forEach((x) => { x.traverse((o) => { if (o.isMesh) o.userData.partId = 'gear'; }); gear.add(x); });
    root.add(gear);

    /* ---- 内部 ---- */
    // 内部构件全部交给 interior.js：那里负责密度、层次与发光
    const inner = CJ.buildInterior(root, mats);
    if (inner.upperLiner) upperGroup.add(inner.upperLiner);

    /* ---- 部件索引（用于高亮 / 聚焦） ---- */
    const byId = {};
    root.traverse((o) => {
      const id = o.userData.partId;
      if (!id) return;
      (byId[id] = byId[id] || []).push(o);
    });

    // 分解引线锚点
    const anchors = [];
    for (let i = 0; i <= 9; i++) {
      const t = 0.08 + (i / 9) * 0.78;
      const pr = profileAt(t);
      anchors.push(new T.Vector3(pr.x, pr.ht, 0));
    }

    return {
      root, upperGroup, lowerGroup, internals: inner.group, engines, anchors,
      mats, parts: byId,
      canopy, wings, fins, gear,
      spin: inner.spin, coreGlow: inner.coreGlow,
      labels: inner.labels,
      upSolid: [mats.hullShellUp, mats.linerUp],
      wingFade,
      upWire: [linesUp.material, secUpL.material, secUpR.material]
    };
  };
})();
