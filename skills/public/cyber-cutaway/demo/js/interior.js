/* =========================================================
   CyberJet · 内部结构
   -----------------------------------------------------
   剖开后能看到的每一层，都按真实机体的构造顺序摆放：
     蒙皮 → 隔热毯 → 隔框 / 纵梁 → 甲板桁架 → 舱内设备
   视觉上靠三件事撑住"高科技感"，缺一件都会塌：
     1) 密度：构件必须有足够的重复次数，形成节奏
     2) 层次：近景结构 / 中景设备 / 远景发光核心，三层景深
     3) 光源：内部必须有自己发光的东西，不能全靠外部打灯
   ========================================================= */
(function () {
  'use strict';

  const T = THREE;
  const CJ = window.CJ;
  const V = (x, y, z) => new T.Vector3(x, y, z);

  const prAt = (t) => CJ.profileAt(t);
  const sp = (pr, th, ins) => CJ.shellPoint(pr, th, ins);
  const prAtX = (x) => CJ.prAtX(x);

  /* =========================================================
     通用工具
     ========================================================= */

  // 把一堆只有 position / normal / index 的几何合并成一个 —— 几百个框只留一次 draw call
  function mergeGeos(list) {
    let vc = 0, ic = 0;
    for (const g of list) {
      if (!g) continue;
      vc += g.attributes.position.count;
      ic += g.index.count;
    }
    const pos = new Float32Array(vc * 3);
    const nor = new Float32Array(vc * 3);
    const idx = new Uint32Array(ic);
    let vo = 0, io = 0;
    for (const g of list) {
      if (!g) continue;
      pos.set(g.attributes.position.array, vo * 3);
      nor.set(g.attributes.normal.array, vo * 3);
      const a = g.index.array;
      for (let i = 0; i < a.length; i++) idx[io + i] = a[i] + vo;
      vo += g.attributes.position.count;
      io += a.length;
      g.dispose();
    }
    const out = new T.BufferGeometry();
    out.setAttribute('position', new T.BufferAttribute(pos, 3));
    out.setAttribute('normal', new T.BufferAttribute(nor, 3));
    out.setIndex(new T.BufferAttribute(idx, 1));
    out.computeBoundingSphere();
    return out;
  }

  // 矩形截面环带：沿超椭圆走一圈，截面是"宽 (iOut→iIn) × 厚 depth"的矩形
  function ringBand(pr, iOut, iIn, depth, x, seg) {
    seg = seg || 36;
    const d = depth * 0.5;
    const pos = [], idx = [];
    for (let j = 0; j <= seg; j++) {
      const th = (j / seg) * Math.PI * 2;
      const a = sp(pr, th, iOut);
      const b = sp(pr, th, iIn);
      pos.push(x - d, a.y, a.z);
      pos.push(x + d, a.y, a.z);
      pos.push(x + d, b.y, b.z);
      pos.push(x - d, b.y, b.z);
    }
    for (let j = 0; j < seg; j++) {
      const A = j * 4, B = (j + 1) * 4;
      for (let k = 0; k < 4; k++) {
        const k2 = (k + 1) % 4;
        idx.push(A + k, B + k, A + k2, A + k2, B + k, B + k2);
      }
    }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }

  // 贴着蒙皮内侧走的纵向条带（灯带 / 电缆槽 / 板材）
  function shellRibbon(theta, inset, x0, x1, halfW, seg) {
    seg = seg || 48;
    const pos = [], idx = [];
    for (let i = 0; i <= seg; i++) {
      const x = x0 + (x1 - x0) * i / seg;
      const pr = prAtX(x);
      const p = sp(pr, theta, inset);
      const q = sp(pr, theta, inset + 0.05);
      let nz = p.z - q.z, ny = p.y - q.y;
      const L = Math.hypot(nz, ny) || 1;
      nz /= L; ny /= L;
      pos.push(p.x, p.y + ny * halfW, p.z + nz * halfW);
      pos.push(p.x, p.y - ny * halfW, p.z - nz * halfW);
    }
    for (let i = 0; i < seg; i++) {
      const A = i * 2, B = A + 2;
      idx.push(A, B, A + 1, A + 1, B, B + 1);
    }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }

  function box(w, h, d, mat, x, y, z, tag) {
    const g = new T.BoxGeometry(w, h, d);
    g.translate(x, y, z);
    const m = new T.Mesh(g, mat);
    if (tag) m.userData.partId = tag;
    return m;
  }

  function tube(points, r, mat, seg, radial) {
    const c = new T.CatmullRomCurve3(points);
    return new T.Mesh(new T.TubeGeometry(c, seg || 48, r, radial || 6, false), mat);
  }

  /* ---- 贴图 ---- */
  CJ.linerTexture = function (bump) {
    const S = 512;
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d');
    g.fillStyle = bump ? '#808080' : '#0d141c';
    g.fillRect(0, 0, S, S);

    const N = 8, s = S / N;
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        const cx = i * s + s / 2, cy = j * s + s / 2;
        if (bump) {
          // 鼓包：中心亮、边缘暗 → 一块块绗缝的隔热毯
          const grd = g.createRadialGradient(cx, cy, 2, cx, cy, s * 0.66);
          grd.addColorStop(0, '#d0d0d0');
          grd.addColorStop(0.72, '#9a9a9a');
          grd.addColorStop(1, '#4c4c4c');
          g.fillStyle = grd;
          g.fillRect(i * s + 2, j * s + 2, s - 4, s - 4);
        } else {
          const grd = g.createRadialGradient(cx, cy, 2, cx, cy, s * 0.7);
          const k = ((i * 7 + j * 13) % 5) * 3;
          grd.addColorStop(0, 'rgb(' + (22 + k) + ',' + (30 + k) + ',' + (40 + k) + ')');
          grd.addColorStop(1, '#0d141c');
          g.fillStyle = grd;
          g.fillRect(i * s + 1, j * s + 1, s - 2, s - 2);
        }
      }
    }
    // 缝线
    g.strokeStyle = bump ? '#3a3a3a' : 'rgba(120,190,220,0.14)';
    g.lineWidth = bump ? 4 : 1.2;
    for (let i = 0; i <= N; i++) {
      g.beginPath(); g.moveTo(i * s, 0); g.lineTo(i * s, S); g.stroke();
      g.beginPath(); g.moveTo(0, i * s); g.lineTo(S, i * s); g.stroke();
    }
    // 箔面颗粒
    if (!bump) {
      for (let i = 0; i < 1400; i++) {
        g.fillStyle = 'rgba(160,210,235,' + (Math.random() * 0.05) + ')';
        g.fillRect(Math.random() * S, Math.random() * S, 2, 2);
      }
    }
    const t = new T.CanvasTexture(c);
    if (!bump && T.sRGBEncoding) t.encoding = T.sRGBEncoding;
    t.wrapS = t.wrapT = T.RepeatWrapping;
    t.repeat.set(3, 16);
    t.anisotropy = 4;
    return t;
  };

  function glowTexture() {
    const S = 128;
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d');
    const grd = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.16, 'rgba(200,250,255,0.85)');
    grd.addColorStop(0.42, 'rgba(90,220,255,0.28)');
    grd.addColorStop(1, 'rgba(40,160,220,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, S, S);
    return new T.CanvasTexture(c);
  }

  function labelTexture(text, sub) {
    const W = 512, H = 128;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    g.clearRect(0, 0, W, H);

    // 左侧角标
    g.strokeStyle = 'rgba(94,242,255,0.9)';
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(4, 30); g.lineTo(4, 4); g.lineTo(40, 4);
    g.stroke();
    g.fillStyle = 'rgba(94,242,255,0.16)';
    g.fillRect(4, 4, 36, 4);

    g.font = '600 38px "Cascadia Code", Consolas, monospace';
    g.fillStyle = '#c9f7ff';
    g.fillText(text, 18, 58);

    if (sub) {
      g.font = '400 22px "Cascadia Code", Consolas, monospace';
      g.fillStyle = 'rgba(120,220,245,0.7)';
      g.fillText(sub, 18, 96);
    }
    const t = new T.CanvasTexture(c);
    if (T.sRGBEncoding) t.encoding = T.sRGBEncoding;
    t.anisotropy = 4;
    return t;
  }

  /* =========================================================
     1 · 隔热毯内衬
     没有这一层，剖开看到的就是一层壳，"空壳气球"感全部来自这里
     ========================================================= */
  function buildLiner(mats) {
    const up = new T.Mesh(CJ.buildHalfShell(true, 0.018), mats.linerUp);
    const lo = new T.Mesh(CJ.buildHalfShell(false, 0.018), mats.liner);
    up.userData.partId = 'hull';
    lo.userData.partId = 'hull';
    return { up, lo };
  }

  /* =========================================================
     2 · 隔框 + 纵梁
     节奏感：等距密排的框 = 机体的"肋骨"，一眼就是结构
     ========================================================= */
  function buildFrames(mats) {
    const g = new T.Group();
    const normal = [], hot = [];
    let i = 0;
    for (let x = -7.5; x <= 9.9; x += 0.74) {
      const pr = prAtX(x);
      if (pr.w < 0.34) continue;
      const isHot = (i % 4 === 0);
      const geo = ringBand(pr, 0.010, i % 2 ? 0.048 : 0.056, 0.05, x, 40);
      (isHot ? hot : normal).push(geo);
      i++;
    }
    const mN = new T.Mesh(mergeGeos(normal), mats.frame);
    const mH = new T.Mesh(mergeGeos(hot), mats.frameHot);
    mN.userData.partId = 'frame';
    mH.userData.partId = 'frame';
    g.add(mN, mH);
    return g;
  }

  function buildStringers(mats) {
    const g = new T.Group();
    const angles = [0.42, 0.98, 1.55, 2.16, 2.68, 3.48, 4.02, 4.6, 5.22, 5.78];
    const geos = [];
    for (const th of angles) {
      const pts = [];
      for (let i = 0; i <= 56; i++) {
        const t = i / 56;
        const pr = prAt(t);
        if (pr.w < 0.36) continue;
        pts.push(sp(pr, th, 0.07));
      }
      if (pts.length < 3) continue;
      const c = new T.CatmullRomCurve3(pts);
      geos.push(new T.TubeGeometry(c, 64, 0.026, 5, false));
    }
    const m = new T.Mesh(mergeGeos(geos), mats.frame);
    m.userData.partId = 'frame';
    g.add(m);
    return g;
  }

  /* =========================================================
     3 · 甲板
     一块只有上表面的板子看起来像纸片，所以做成有厚度的板条：
     上面板 / 下面板 / 两侧立面，剖开时能看见断面
     ========================================================= */
  function deckHalfWidth(x) {
    const pr = prAtX(x);
    return Math.min(pr.w * 0.87, 1.28);
  }

  function buildDeck(mats) {
    const g = new T.Group();
    const x0 = -0.55, x1 = 7.45, seg = 52;
    const yT = -0.50, th = 0.10;
    const pos = [], idx = [];

    for (let i = 0; i <= seg; i++) {
      const x = x0 + (x1 - x0) * i / seg;
      const w = deckHalfWidth(x);
      pos.push(x, yT, -w);          // 0 左上
      pos.push(x, yT - th, -w);     // 1 左下
      pos.push(x, yT - th, w);      // 2 右下
      pos.push(x, yT, w);           // 3 右上
    }
    for (let i = 0; i < seg; i++) {
      const A = i * 4, B = (i + 1) * 4;
      for (let k = 0; k < 4; k++) {
        const k2 = (k + 1) % 4;
        idx.push(A + k, B + k, A + k2, A + k2, B + k, B + k2);
      }
    }
    const geo = new T.BufferGeometry();
    geo.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const deck = new T.Mesh(geo, mats.floor);
    deck.userData.partId = 'cabin';
    g.add(deck);

    // 甲板横梁（桁架感）
    const beams = [];
    for (let x = x0 + 0.4; x < x1; x += 0.78) {
      const w = deckHalfWidth(x);
      const b = new T.BoxGeometry(0.075, 0.16, w * 2);
      b.translate(x, yT - th - 0.10, 0);
      beams.push(b);
    }
    const bm = new T.Mesh(mergeGeos(beams), mats.beam);
    bm.userData.partId = 'cabin';
    g.add(bm);

    // 甲板两侧向下的斜撑 —— 结构感的关键，不然甲板像浮在空中
    const struts = [];
    for (let x = x0 + 0.8; x < x1; x += 1.56) {
      const pr = prAtX(x);
      const w = deckHalfWidth(x);
      for (const s of [-1, 1]) {
        const top = V(x, yT - th - 0.06, s * w * 0.94);
        const bot = sp(pr, s > 0 ? 1.05 : 4.23, 0.09);
        const mid = top.clone().add(bot).multiplyScalar(0.5);
        const len = top.distanceTo(bot);
        const b = new T.BoxGeometry(0.06, len, 0.06);
        const dir = bot.clone().sub(top).normalize();
        const q = new T.Quaternion().setFromUnitVectors(V(0, 1, 0), dir);
        b.applyQuaternion(q);
        b.translate(mid.x, mid.y, mid.z);
        struts.push(b);
      }
    }
    if (struts.length) {
      const sm = new T.Mesh(mergeGeos(struts), mats.frame);
      sm.userData.partId = 'frame';
      g.add(sm);
    }

    // 中央通道踏板
    const aisle = box(7.9, 0.012, 0.52, mats.rack, 3.45, yT + 0.008, 0, 'cabin');
    g.add(aisle);

    // 甲板分仓缝：把一整块大平面切成一块块地板，视觉上立刻有"结构"了
    const seams = [];
    for (let x = x0 + 0.79; x < x1 - 0.1; x += 0.79) {
      const w = deckHalfWidth(x);
      const b = new T.BoxGeometry(0.022, 0.008, w * 2 * 0.98);
      b.translate(x, yT + 0.004, 0);
      seams.push(b);
    }
    for (const zz of [-0.62, 0.62]) {
      const b = new T.BoxGeometry(x1 - x0 - 0.2, 0.008, 0.018);
      b.translate((x0 + x1) / 2, yT + 0.004, zz);
      seams.push(b);
    }
    const sm = new T.Mesh(mergeGeos(seams), mats.seamDark);
    sm.userData.partId = 'cabin';
    g.add(sm);

    // 甲板边缘灯槽：一条冷白 + 一条琥珀，冷暖对比全靠这个
    for (const s of [-1, 1]) {
      const led = box(7.9, 0.016, 0.028, mats.led, 3.45, yT + 0.004, s * 1.10, 'cabin');
      g.add(led);
      const chan = box(7.9, 0.05, 0.09, mats.rack, 3.45, yT - 0.02, s * 1.10, 'cabin');
      g.add(chan);
    }

    return g;
  }

  /* =========================================================
     4 · 座椅阵列
     ========================================================= */
  function buildSeats(mats) {
    const g = new T.Group();
    const rows = [6.55, 5.40, 4.25, 3.10];
    const colsZ = [-0.92, -0.34, 0.34, 0.92];
    const n = rows.length * colsZ.length;
    const yB = -0.44;

    const panG = new T.BoxGeometry(0.46, 0.10, 0.44);
    const backG = new T.BoxGeometry(0.11, 0.60, 0.44);
    const headG = new T.BoxGeometry(0.13, 0.17, 0.28);
    const armG = new T.BoxGeometry(0.40, 0.05, 0.05);

    const pan = new T.InstancedMesh(panG, mats.seat, n);
    const back = new T.InstancedMesh(backG, mats.seatHot, n);
    const head = new T.InstancedMesh(headG, mats.seat, n);
    const armL = new T.InstancedMesh(armG, mats.seat, n);
    const armR = new T.InstancedMesh(armG, mats.seat, n);

    const m4 = new T.Matrix4();
    const q = new T.Quaternion();
    const qBack = new T.Quaternion().setFromAxisAngle(V(0, 0, 1), 0.18);
    const one = V(1, 1, 1);

    let k = 0;
    for (const x of rows) {
      for (const z of colsZ) {
        m4.compose(V(x, yB, z), q, one); pan.setMatrixAt(k, m4);
        m4.compose(V(x - 0.22, yB + 0.30, z), qBack, one); back.setMatrixAt(k, m4);
        m4.compose(V(x - 0.28, yB + 0.60, z), q, one); head.setMatrixAt(k, m4);
        m4.compose(V(x - 0.02, yB + 0.10, z - 0.23), q, one); armL.setMatrixAt(k, m4);
        m4.compose(V(x - 0.02, yB + 0.10, z + 0.23), q, one); armR.setMatrixAt(k, m4);
        k++;
      }
    }
    [pan, back, head, armL, armR].forEach((m) => {
      m.instanceMatrix.needsUpdate = true;
      m.userData.partId = 'cabin';
      g.add(m);
    });

    // 座椅上方的行李架：两条长舱壁板 + 边缘冷光
    for (const s of [-1, 1]) {
      for (const x of rows) {
        const bin = box(1.02, 0.30, 0.42, mats.rack, x, 0.34, s * 0.98, 'cabin');
        g.add(bin);
        const edge = box(1.02, 0.014, 0.016, mats.led, x, 0.34, s * 0.76, 'cabin');
        g.add(edge);
      }
    }

    return g;
  }

  /* =========================================================
     5 · 驾驶舱
     ========================================================= */
  function buildCockpit(mats) {
    const g = new T.Group();

    // 驾驶舱地板
    g.add(box(2.2, 0.08, 1.5, mats.floor, 9.5, -0.26, 0, 'cockpit'));

    // 仪表台
    const dash = box(0.46, 0.52, 1.44, mats.rack, 10.28, -0.04, 0, 'cockpit');
    dash.rotation.z = -0.22;
    g.add(dash);

    // 三块显示屏（自发光，直接用 basic 材质 + 描边）
    for (let i = -1; i <= 1; i++) {
      const scr = box(0.02, 0.28, 0.36, mats.led, 10.06, 0.10, i * 0.44, 'cockpit');
      g.add(scr);
      const frame = box(0.03, 0.33, 0.41, mats.rack, 10.08, 0.10, i * 0.44, 'cockpit');
      g.add(frame);
    }
    // HUD 投影片
    const hud = new T.Mesh(new T.PlaneGeometry(0.72, 0.4), new T.MeshBasicMaterial({
      color: 0x66e8ff, transparent: true, opacity: 0.20, side: T.DoubleSide,
      blending: T.AdditiveBlending, depthWrite: false, toneMapped: false
    }));
    hud.position.set(9.72, 0.34, 0);
    hud.rotation.y = Math.PI / 2;
    hud.userData.partId = 'cockpit';
    g.add(hud);

    // 两张座椅
    for (const z of [-0.36, 0.36]) {
      g.add(box(0.44, 0.09, 0.42, mats.seat, 9.10, -0.20, z, 'cockpit'));
      const back = box(0.10, 0.55, 0.40, mats.seatHot, 8.90, 0.09, z, 'cockpit');
      back.rotation.z = 0.18;
      g.add(back);
      g.add(box(0.12, 0.16, 0.26, mats.seat, 8.84, 0.38, z, 'cockpit'));
    }
    // 操纵杆
    for (const z of [-0.36, 0.36]) {
      g.add(box(0.05, 0.24, 0.05, mats.metal, 9.62, -0.02, z, 'cockpit'));
      g.add(box(0.06, 0.07, 0.10, mats.ledAmber, 9.62, 0.12, z, 'cockpit'));
    }

    return g;
  }

  /* =========================================================
     6 · 动力核心
     内部唯一的大光源。有了它，整个剖面才有"心脏"
     ========================================================= */
  function buildCore(mats) {
    const g = new T.Group();
    const CX = -1.45, CY = -0.02;
    const spin = [];

    // 约束笼：12 根立筋 + 两道环
    const cage = [];
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2;
      const b = new T.BoxGeometry(0.05, 0.05, 0.05);
      b.translate(0, 0, 0);
      const len = 0.86;
      const gg = new T.CylinderGeometry(0.026, 0.026, len, 5);
      gg.rotateX(Math.PI / 2);
      gg.rotateY(a);
      gg.translate(CX, CY + Math.sin(a) * 0.62, Math.cos(a) * 0.62);
      cage.push(gg);
    }
    for (const s of [-1, 1]) {
      const t = new T.TorusGeometry(0.62, 0.028, 6, 40);
      t.rotateY(Math.PI / 2);
      t.translate(CX + s * 0.36, CY, 0);
      cage.push(t);
    }
    const cageMesh = new T.Mesh(mergeGeos(cage), mats.coreCage);
    cageMesh.userData.partId = 'core';
    g.add(cageMesh);

    // 三轴旋转环
    [[0.78, 0, 0], [0.70, Math.PI / 3, 0.55], [0.63, -Math.PI / 3, -0.4]].forEach((cfg, i) => {
      const r = new T.Mesh(new T.TorusGeometry(cfg[0], 0.024, 5, 48), mats.coreRing);
      r.position.set(CX, CY, 0);
      r.rotation.set(cfg[1], cfg[2], 0);
      r.userData.partId = 'core';
      r.userData.spinAxis = i % 2 ? 'y' : 'z';
      r.userData.spinSpeed = 0.9 - i * 0.25;
      spin.push(r);
      g.add(r);
    });

    // 核心球
    const ball = new T.Mesh(new T.SphereGeometry(0.30, 24, 18), mats.coreShell);
    ball.position.set(CX, CY, 0);
    ball.userData.partId = 'core';
    g.add(ball);

    // 辉光
    const glow = new T.Sprite(new T.SpriteMaterial({
      map: glowTexture(), color: 0xa8f0ff, transparent: true, opacity: 0.85,
      blending: T.AdditiveBlending, depthWrite: false, toneMapped: false
    }));
    glow.position.set(CX, CY, 0);
    glow.scale.set(1.7, 1.7, 1);
    g.add(glow);

    const glow2 = new T.Sprite(new T.SpriteMaterial({
      map: glowTexture(), color: 0xff2d78, transparent: true, opacity: 0.7,
      blending: T.AdditiveBlending, depthWrite: false, toneMapped: false
    }));
    glow2.position.set(CX, CY, 0);
    glow2.scale.set(3.2, 3.2, 1);
    g.add(glow2);

    return { group: g, spin, glow, glow2, x: CX, y: CY };
  }

  /* =========================================================
     7 · 低温氢罐 + 泵组
     ========================================================= */
  function buildTanks(mats) {
    const g = new T.Group();
    for (const x of [-4.35, -5.85]) {
      const t = new T.Mesh(new T.CapsuleGeometry(0.50, 1.05, 6, 20), mats.tank);
      t.rotation.z = Math.PI / 2;
      t.position.set(x, -0.42, 0);
      t.userData.partId = 'fuel';
      g.add(t);

      for (const dx of [-0.36, 0.36]) {
        const b = new T.Mesh(new T.TorusGeometry(0.505, 0.026, 5, 26), mats.tankBand);
        b.rotation.y = Math.PI / 2;
        b.position.set(x + dx, -0.42, 0);
        b.userData.partId = 'fuel';
        g.add(b);
      }
      // 加注口 + 液位指示
      const cap = new T.Mesh(new T.CylinderGeometry(0.08, 0.08, 0.16, 10), mats.metal);
      cap.position.set(x, 0.12, 0);
      cap.userData.partId = 'fuel';
      g.add(cap);

      // 支撑鞍座
      const sad = box(0.16, 0.30, 0.9, mats.frame, x, -0.86, 0, 'fuel');
      g.add(sad);
    }
    // 泵组
    for (const z of [-0.34, 0.34]) {
      g.add(box(0.34, 0.30, 0.26, mats.rack, -3.45, -0.72, z, 'fuel'));
      g.add(box(0.05, 0.05, 0.05, mats.led, -3.28, -0.62, z, 'fuel'));
    }
    return g;
  }

  /* =========================================================
     8 · 线束 / 导管 / 电缆槽
     从"几根管"到"一束一束的管"，密度差一倍，质感差十倍
     ========================================================= */
  function buildHarness(mats) {
    const g = new T.Group();

    const bundles = [
      { th: 2.30, inset: 0.16, n: 5, r: 0.020, x0: -3.2, x1: 7.2 },
      { th: 3.98, inset: 0.16, n: 5, r: 0.020, x0: -3.2, x1: 7.2 },
      { th: 0.55, inset: 0.18, n: 4, r: 0.024, x0: -0.4, x1: 7.0 },
      { th: 5.73, inset: 0.18, n: 4, r: 0.024, x0: -0.4, x1: 7.0 }
    ];

    const geos = [];
    for (const b of bundles) {
      for (let k = 0; k < b.n; k++) {
        const pts = [];
        const off = (k - (b.n - 1) / 2) * 0.032;
        for (let x = b.x0; x <= b.x1; x += 0.35) {
          const pr = prAtX(x);
          const p = sp(pr, b.th, b.inset);
          // 每两个框之间下垂一点，线束才有重量感
          const sag = 0.022 * Math.abs(Math.sin(x * 2.1));
          const nz = p.z, ny = p.y;
          const L = Math.hypot(nz, ny) || 1;
          pts.push(V(p.x, p.y - sag + off * (ny / L), p.z + off * (nz / L)));
        }
        const c = new T.CatmullRomCurve3(pts);
        geos.push(new T.TubeGeometry(c, 90, b.r, 5, false));
      }
    }
    const hm = new T.Mesh(mergeGeos(geos), mats.wire);
    hm.userData.partId = 'conduit';
    g.add(hm);

    // 主干导管：粗、带法兰、通到动力核心
    const mains = [
      { y: -0.98, z: 0.62, r: 0.062, x0: -6.9, x1: -0.2 },
      { y: -0.98, z: -0.62, r: 0.062, x0: -6.9, x1: -0.2 },
      { y: 0.30, z: 1.06, r: 0.048, x0: -1.4, x1: 7.2 },
      { y: 0.30, z: -1.06, r: 0.048, x0: -1.4, x1: 7.2 }
    ];
    for (const m of mains) {
      const pts = [];
      for (let x = m.x0; x <= m.x1; x += 0.4) {
        const pr = prAtX(x);
        const k = Math.min(1, pr.w / 1.4);
        pts.push(V(x, m.y * k, m.z * k));
      }
      if (pts.length < 3) continue;
      g.add(tube(pts, m.r, mats.conduit, 70, 7));

      // 法兰环
      for (let x = m.x0 + 0.8; x < m.x1; x += 1.5) {
        const pr = prAtX(x);
        const k = Math.min(1, pr.w / 1.4);
        const f = new T.Mesh(new T.TorusGeometry(m.r * 1.25, 0.014, 4, 14), mats.metal);
        f.rotation.y = Math.PI / 2;
        f.position.set(x, m.y * k, m.z * k);
        f.userData.partId = 'conduit';
        g.add(f);
      }
    }

    // 电缆槽（U 形槽 + 里面的发光线）
    for (const s of [-1, 1]) {
      const th = s > 0 ? 1.20 : 3.94;
      const tray = new T.Mesh(shellRibbon(th, 0.115, 1.0, 7.2, 0.085, 40), mats.rack);
      tray.userData.partId = 'conduit';
      g.add(tray);
      const line = new T.Mesh(shellRibbon(th, 0.145, 1.0, 7.2, 0.012, 40), mats.led);
      line.userData.partId = 'conduit';
      g.add(line);
    }

    return g;
  }

  /* =========================================================
     9 · 航电舱 / 设备架
     ========================================================= */
  function buildAvionics(mats) {
    const g = new T.Group();

    // 机架箱体
    for (const s of [-1, 1]) {
      for (let i = 0; i < 3; i++) {
        const x = 7.42 + i * 0.42;
        g.add(box(0.40, 1.05, 0.42, mats.rack, x, -0.05, s * 0.86, 'avionics'));
      }
    }
    // LED 阵列：小方块密排，远看是"一片在跑数据的面板"
    const ledG = new T.BoxGeometry(0.028, 0.028, 0.006);
    const n = 3 * 6 * 6 * 2;
    const leds = new T.InstancedMesh(ledG, mats.led, n);
    const m4 = new T.Matrix4();
    const q = new T.Quaternion();
    const one = V(1, 1, 1);
    let k = 0;
    for (const s of [-1, 1]) {
      for (let i = 0; i < 3; i++) {
        const x = 7.42 + i * 0.42;
        for (let a = 0; a < 6; a++) {
          for (let b = 0; b < 6; b++) {
            m4.compose(
              V(x - 0.13 + a * 0.052, -0.46 + b * 0.16, s * 0.655), q, one
            );
            leds.setMatrixAt(k++, m4);
          }
        }
      }
    }
    leds.instanceMatrix.needsUpdate = true;
    leds.userData.partId = 'avionics';
    g.add(leds);

    return g;
  }

  /* =========================================================
     10 · 货舱
     甲板下面是真实客机最"有货"的地方，塞满之后层次立刻厚起来
     ========================================================= */
  function buildCargo(mats) {
    const g = new T.Group();
    const yB = -1.02;
    let i = 0;
    for (let x = 0.35; x < 5.9; x += 1.42) {
      const w = Math.min(deckHalfWidth(x) * 1.5, 1.55);
      const h = 0.52 + (i % 2) * 0.10;
      g.add(box(1.26, h, w, mats.cargo, x, yB - (0.62 - h) * 0.2, 0, 'cabin'));
      // 绑带
      for (const s of [-1, 1]) {
        g.add(box(1.30, 0.022, 0.05, mats.cable, x, yB + h * 0.30, s * w * 0.36, 'cabin'));
      }
      // 货舱照明
      if (i % 2 === 0) g.add(box(0.7, 0.016, 0.024, mats.ledAmber, x + 0.5, yB + 0.60, 0, 'cabin'));
      i++;
    }
    return g;
  }

  /* =========================================================
     11 · 舱内灯带（天花板）
     没有灯带的机舱永远是黑的。这一层同时也是相机视角的"引导线"
     ========================================================= */
  function buildCeilingLights(mats) {
    const g = new T.Group();
    // 沿剖开边缘走的两条灯槽：切开之后，这两条线就是最抢眼的引导线
    const lanes = [
      { th: 0.13 * Math.PI, x0: 1.0, x1: 7.3 },
      { th: 0.87 * Math.PI, x0: 1.0, x1: 7.3 },
      { th: 0.20 * Math.PI, x0: -6.4, x1: 0.4 },
      { th: 0.80 * Math.PI, x0: -6.4, x1: 0.4 }
    ];
    for (const l of lanes) {
      const chan = new T.Mesh(shellRibbon(l.th, 0.085, l.x0, l.x1, 0.055, 40), mats.rack);
      chan.userData.partId = 'cabin';
      g.add(chan);
      const bar = new T.Mesh(shellRibbon(l.th, 0.115, l.x0, l.x1, 0.020, 40), mats.led);
      bar.userData.partId = 'cabin';
      g.add(bar);
    }
    // 动力舱的一圈警示灯
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const m = box(0.06, 0.02, 0.06, mats.coreRing,
        -2.95 + (i % 3) * 0.12, Math.sin(a) * 0.72, Math.cos(a) * 0.72, 'core');
      g.add(m);
    }
    return g;
  }

  /* =========================================================
     12 · 全息标注
     三维空间里飘着可读文字，是"这是高科技"最直接的信号
     ========================================================= */
  function buildHolo(mats) {
    const g = new T.Group();
    const items = [
      { t: 'FR-21  LOAD FRAME', s: 'Ti-6Al-4V · 21 RINGS', p: V(2.9, 0.72, 1.02), a: V(2.9, 0.30, 0.30) },
      { t: 'DECK BEAM', s: '7050-T7451 · 6.4 m', p: V(5.2, -0.86, 1.05), a: V(5.2, -0.62, 0.30) },
      { t: 'FUSION CORE', s: '2.4 GW · MAG-CONFINED', p: V(-2.6, 0.86, 0.95), a: V(-1.45, 0.30, 0.20) },
      { t: 'CRYO H₂', s: '20 K · 6800 L', p: V(-5.1, 0.62, 0.92), a: V(-5.1, 0.02, 0.20) },
      { t: 'BUS 2400V', s: '1200 A · SHIELDED', p: V(0.6, -0.95, 0.98), a: V(0.6, -0.98, 0.55) }
    ];

    const labelMats = [];
    const linePts = [];

    items.forEach((it) => {
      const mat = new T.SpriteMaterial({
        map: labelTexture(it.t, it.s), transparent: true, opacity: 0,
        depthTest: false, depthWrite: false, toneMapped: false
      });
      labelMats.push(mat);
      const s = new T.Sprite(mat);
      s.position.copy(it.p);
      s.scale.set(2.0, 0.5, 1);
      g.add(s);

      linePts.push(it.p.x, it.p.y - 0.02, it.p.z, it.a.x, it.a.y, it.a.z);
    });

    const lg = new T.BufferGeometry();
    lg.setAttribute('position', new T.Float32BufferAttribute(linePts, 3));
    const lineMat = new T.LineBasicMaterial({
      color: 0x5ef2ff, transparent: true, opacity: 0, depthTest: false, toneMapped: false
    });
    labelMats.push(lineMat);
    g.add(new T.LineSegments(lg, lineMat));

    return { group: g, mats: labelMats };
  }

  /* =========================================================
     汇总
     ========================================================= */
  CJ.buildInterior = function (root, mats) {
    const group = new T.Group();
    const spin = [];

    const liner = buildLiner(mats);
    const frames = buildFrames(mats);
    const stringers = buildStringers(mats);
    const deck = buildDeck(mats);
    const seats = buildSeats(mats);
    const cockpit = buildCockpit(mats);
    const core = buildCore(mats);
    const tanks = buildTanks(mats);
    const harness = buildHarness(mats);
    const avionics = buildAvionics(mats);
    const cargo = buildCargo(mats);
    const lights = buildCeilingLights(mats);
    const holo = buildHolo(mats);

    spin.push(...core.spin);

    group.add(liner.lo, frames, stringers, deck, seats, cockpit,
      core.group, tanks, harness, avionics, cargo, lights, holo.group);
    root.add(group);

    return {
      group,
      spin,
      coreGlow: [core.glow, core.glow2],
      labels: holo.mats,
      corePos: V(core.x, core.y, 0),
      upperLiner: liner.up
    };
  };
})();
