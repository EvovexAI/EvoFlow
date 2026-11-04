/* =========================================================
   CyberJet · 场景 / 相机 / 交互
   ========================================================= */
(function () {
  'use strict';

  const T = THREE;
  const CJ = window.CJ;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, t) => a + (b - a) * t;

  /* ---------------- 辅助贴图 ---------------- */
  function beamTexture() {
    const c = document.createElement('canvas');
    c.width = 128; c.height = 64;
    const g = c.getContext('2d');
    const grd = g.createLinearGradient(0, 0, 128, 0);
    grd.addColorStop(0, 'rgba(90,240,255,0)');
    grd.addColorStop(0.42, 'rgba(150,250,255,0.55)');
    grd.addColorStop(0.5, 'rgba(220,255,255,0.95)');
    grd.addColorStop(0.58, 'rgba(150,250,255,0.55)');
    grd.addColorStop(1, 'rgba(90,240,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 128, 64);
    const t = new T.CanvasTexture(c);
    t.wrapS = t.wrapT = T.ClampToEdgeWrapping;
    return t;
  }

  function shadowTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const g = c.getContext('2d');
    const grd = g.createRadialGradient(128, 128, 10, 128, 128, 126);
    grd.addColorStop(0, 'rgba(0,0,0,0.75)');
    grd.addColorStop(0.55, 'rgba(0,0,0,0.28)');
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 256, 256);
    return new T.CanvasTexture(c);
  }

  function envTexture() {
    const c = document.createElement('canvas');
    c.width = 1024; c.height = 512;
    const g = c.getContext('2d');

    /* 环境贴图是金属材质的命门：它决定高光从哪来、有多亮。
       太暗 → 金属死黑；太均匀 → 塑料。必须是"几条强光 + 大片暗"。 */
    const grd = g.createLinearGradient(0, 0, 0, 512);
    grd.addColorStop(0.00, '#123049');
    grd.addColorStop(0.22, '#0a1826');
    grd.addColorStop(0.48, '#050a11');
    grd.addColorStop(0.66, '#02050a');
    grd.addColorStop(1.00, '#000203');
    g.fillStyle = grd;
    g.fillRect(0, 0, 1024, 512);

    // 顶部机库灯排：条带 + 溢光
    for (let i = 0; i < 5; i++) {
      const y = 26 + i * 30;
      const a = 1 - i * 0.16;
      g.fillStyle = 'rgba(225,250,255,' + (a * 0.95) + ')';
      g.fillRect(0, y, 1024, 6 - i * 0.6);
      const halo = g.createLinearGradient(0, y, 0, y + 46);
      halo.addColorStop(0, 'rgba(150,235,255,' + (a * 0.30) + ')');
      halo.addColorStop(1, 'rgba(150,235,255,0)');
      g.fillStyle = halo;
      g.fillRect(0, y + 6, 1024, 46);
    }

    // 侧向竖条灯（给圆柱面制造长条形高光）
    for (let i = 0; i < 10; i++) {
      const x = i * 102.4 + 34;
      g.fillStyle = 'rgba(150,240,255,0.10)';
      g.fillRect(x, 10, 5, 250);
    }

    // 品红补光带（左后）
    let mg = g.createLinearGradient(0, 250, 0, 340);
    mg.addColorStop(0, 'rgba(255,61,127,0)');
    mg.addColorStop(0.5, 'rgba(255,61,127,0.42)');
    mg.addColorStop(1, 'rgba(255,61,127,0)');
    g.fillStyle = mg;
    g.fillRect(0, 250, 512, 90);

    // 琥珀补光带（右前）
    let am = g.createLinearGradient(512, 300, 1024, 300);
    am.addColorStop(0, 'rgba(255,181,71,0)');
    am.addColorStop(0.5, 'rgba(255,181,71,0.30)');
    am.addColorStop(1, 'rgba(255,181,71,0)');
    g.fillStyle = am;
    g.fillRect(512, 296, 512, 44);

    // 地面：一块亮面，让下表面有反射
    const fl = g.createLinearGradient(0, 452, 0, 512);
    fl.addColorStop(0, 'rgba(80,170,205,0.34)');
    fl.addColorStop(1, 'rgba(10,30,44,0.05)');
    g.fillStyle = fl;
    g.fillRect(0, 452, 1024, 60);

    const t = new T.CanvasTexture(c);
    if (T.sRGBEncoding) t.encoding = T.sRGBEncoding;
    t.mapping = T.EquirectangularReflectionMapping;
    return t;
  }

  function CyberJet(canvas, glowCanvas) {
    this.canvas = canvas;
    this.glowCanvas = glowCanvas;
    this.glowCtx = glowCanvas.getContext('2d');

    this.renderer = new T.WebGLRenderer({
      canvas, antialias: true, alpha: false, preserveDrawingBuffer: true,
      powerPreference: 'high-performance'
    });
    this.renderer.setClearColor(0x03060c, 1);
    if (T.sRGBEncoding) this.renderer.outputEncoding = T.sRGBEncoding;
    this.renderer.toneMapping = T.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.18;

    this.scene = new T.Scene();
    this.scene.background = new T.Color(0x03060c);
    this.scene.fog = new T.FogExp2(0x03060c, 0.017);

    // 金属材质没有环境贴图就是死黑一片 —— 这是立体感的命门
    const pmrem = new T.PMREMGenerator(this.renderer);
    pmrem.compileEquirectangularShader();
    this.envMap = pmrem.fromEquirectangular(envTexture()).texture;
    this.scene.environment = this.envMap;

    this.camera = new T.PerspectiveCamera(42, 1, 0.1, 400);

    this.cam = {
      theta: 0.95, phi: 0.86, dist: 30,
      tTheta: 0.95, tPhi: 0.86, tDist: 30,
      target: new T.Vector3(0, 0, 0),
      tTarget: new T.Vector3(0, 0, 0),
      auto: true
    };

    this.pointer = { down: false, x: 0, y: 0, idle: 0, moved: 0 };
    this.open = 0;         // 剖开程度 0..1
    this.openTarget = 0;
    this.xray = 0;
    this.xrayTarget = 0;
    this.clock = new T.Clock();
    this.t = 0;
    this.selected = null;
    this.fps = 60;
    this._fpsAcc = 0;
    this._fpsN = 0;

    this._buildEnvironment();
    this._buildLights();
    this._buildShip();
    this._buildAtmos();
    this._bindInput();
    this.resize();
  }

  /* ---------------- 环境 ---------------- */
  CyberJet.prototype._buildEnvironment = function () {
    const s = this.scene;

    // 地面网格
    const grid = new T.GridHelper(120, 60, 0x136077, 0x0a2c3a);
    grid.position.y = -3.3;
    grid.material.transparent = true;
    grid.material.opacity = 0.55;
    s.add(grid);

    // 停机坪圆环
    for (let i = 0; i < 3; i++) {
      const r = 9 + i * 5.5;
      const ring = new T.Mesh(
        new T.RingGeometry(r, r + 0.08, 96),
        new T.MeshBasicMaterial({
          color: i === 1 ? 0x2ad0ff : 0x0f6076,
          transparent: true, opacity: i === 1 ? 0.55 : 0.3,
          side: T.DoubleSide, blending: T.AdditiveBlending, depthWrite: false
        })
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = -3.28;
      s.add(ring);
    }

    // 假接触阴影
    const shadow = new T.Mesh(
      new T.PlaneGeometry(34, 15),
      new T.MeshBasicMaterial({
        map: shadowTexture(), transparent: true, opacity: 0.85,
        depthWrite: false
      })
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = -3.26;
    s.add(shadow);

    // 远处机库立柱
    const pillarMat = new T.MeshBasicMaterial({
      color: 0x0e3546, transparent: true, opacity: 0.6, depthWrite: false
    });
    for (let i = -4; i <= 4; i++) {
      const p = new T.Mesh(new T.BoxGeometry(0.6, 26, 0.6), pillarMat);
      p.position.set(i * 16, 6, -46);
      s.add(p);
    }
    // 地平线光带
    for (let i = 0; i < 3; i++) {
      const bar = new T.Mesh(
        new T.BoxGeometry(150, 0.05, 0.05),
        new T.MeshBasicMaterial({
          color: i === 1 ? 0x2ad0ff : 0x124a5c,
          transparent: true, opacity: 0.5,
          blending: T.AdditiveBlending, depthWrite: false
        })
      );
      bar.position.set(0, -3.2 + i * 3.4, -44 - i * 4);
      s.add(bar);
    }

    // 尘埃
    const N = 420;
    const pos = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 70;
      pos[i * 3 + 1] = (Math.random() - 0.5) * 26;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 70;
    }
    const dg = new T.BufferGeometry();
    dg.setAttribute('position', new T.BufferAttribute(pos, 3));
    this.dust = new T.Points(dg, new T.PointsMaterial({
      color: 0x5fd8ea, size: 0.07, transparent: true, opacity: 0.55,
      depthWrite: false, blending: T.AdditiveBlending
    }));
    s.add(this.dust);
  };

  /* ---------------- 灯光 ---------------- */
  CyberJet.prototype._buildLights = function () {
    const s = this.scene;
    s.add(new T.AmbientLight(0x1a3044, 0.55));

    // 主光：冷白，从右上方压下来，负责金属面的主高光
    const key = new T.DirectionalLight(0xd6f2ff, 1.95);
    key.position.set(16, 22, 13);
    s.add(key);

    // 侧光：品红，从左后方打，负责轮廓和色彩对撞
    const fill = new T.DirectionalLight(0xff2d78, 0.30);
    fill.position.set(-18, 3, -16);
    s.add(fill);

    // 补光：青，从右前方，抬起暗部
    const rim = new T.DirectionalLight(0x6ff4ff, 0.85);
    rim.position.set(-4, 9, 19);
    s.add(rim);

    // 顶部轮廓光：把机背勾出来
    const top = new T.DirectionalLight(0xbfeaff, 0.70);
    top.position.set(0, 30, -6);
    s.add(top);

    // 地面反光
    const under = new T.PointLight(0x2ad0ff, 30, 50, 2);
    under.position.set(0, -4.2, 0);
    s.add(under);

    const nose = new T.PointLight(0xff3d7f, 5.0, 22, 2);
    nose.position.set(-11, 3.2, 5);
    s.add(nose);

    /* ---- 内部灯：这些才是剖面能不能"活"的决定因素 ---- */
    // 客舱前段（冷白，压在天花板下）
    this.cabinLightA = new T.PointLight(0xbdf0ff, 0, 12, 2);
    this.cabinLightA.position.set(5.6, 0.70, 0);
    s.add(this.cabinLightA);

    // 客舱后段（冷白）
    this.cabinLightB = new T.PointLight(0xbdf0ff, 0, 11, 2);
    this.cabinLightB.position.set(2.4, 0.70, 0);
    s.add(this.cabinLightB);

    // 动力核心（品红，从核心球内部往外打）
    this.coreLight = new T.PointLight(0xff5a90, 0, 14, 2);
    this.coreLight.position.set(-1.45, 0, 0);
    s.add(this.coreLight);

    // 核心外溢（青，稍微偏一点方向，制造冷暖叠色）
    this.coreLight2 = new T.PointLight(0x7fe4ff, 0, 12, 2);
    this.coreLight2.position.set(-1.45, 0.45, 0.35);
    s.add(this.coreLight2);

    // 低温罐区（紫）
    this.tankLight = new T.PointLight(0x9d7bff, 0, 10, 2);
    this.tankLight.position.set(-5.1, -0.2, 0);
    s.add(this.tankLight);

    // 货舱（琥珀，地板下面）
    this.cargoLight = new T.PointLight(0xffb547, 0, 8, 2);
    this.cargoLight.position.set(3.0, -1.05, 0);
    s.add(this.cargoLight);
  };

  /* ---------------- 内部氛围（体积光 / 浮尘） ---------------- */
  function shaftMaterial() {
    return new T.ShaderMaterial({
      uniforms: {
        uColor: { value: new T.Color(0x9fe8ff) },
        uOpacity: { value: 0.0 }
      },
      vertexShader: [
        'varying vec2 vUv;',
        'varying vec3 vN;',
        'varying vec3 vV;',
        'void main(){',
        '  vUv = uv;',
        '  vec4 mv = modelViewMatrix * vec4(position,1.0);',
        '  vN = normalize(normalMatrix * normal);',
        '  vV = normalize(-mv.xyz);',
        '  gl_Position = projectionMatrix * mv;',
        '}'
      ].join('\n'),
      fragmentShader: [
        'uniform vec3 uColor;',
        'uniform float uOpacity;',
        'varying vec2 vUv;',
        'varying vec3 vN;',
        'varying vec3 vV;',
        'void main(){',
        // 竖向渐隐：底部亮、顶部淡
        '  float fall = pow(1.0 - vUv.y, 1.6);',
        // 侧缘渐隐：正对视线时最亮，掠射时消失 —— 圆锥不会变成硬边梯形
        '  float edge = pow(abs(dot(normalize(vN), normalize(vV))), 1.4);',
        '  edge = mix(0.15, 1.0, edge);',
        '  float a = fall * edge * uOpacity;',
        '  gl_FragColor = vec4(uColor * a, a);',
        '}'
      ].join('\n'),
      transparent: true,
      blending: T.AdditiveBlending,
      depthWrite: false,
      side: T.DoubleSide,
      toneMapped: false
    });
  }

  CyberJet.prototype._buildAtmos = function () {
    const s = this.scene;

    // 从掀开的上盖缝隙里打下来的几道光锥
    this.shafts = [];
    const cfg = [
      { x: 5.50, r0: 0.26, r1: 0.85, h: 4.4, c: 0x9fe8ff },
      { x: 2.20, r0: 0.22, r1: 0.72, h: 4.4, c: 0xcfefff },
      { x: -1.45, r0: 0.18, r1: 0.60, h: 4.4, c: 0xffa8c8 }
    ];
    cfg.forEach((c) => {
      const geo = new T.CylinderGeometry(c.r0, c.r1, c.h, 26, 1, true);
      const m = new T.Mesh(geo, shaftMaterial());
      m.material.uniforms.uColor.value.setHex(c.c);
      m.position.set(c.x, 1.1, 0);
      m.renderOrder = 6;
      m.visible = false;
      s.add(m);
      this.shafts.push(m);
    });

    // 舱内浮尘：限制在机身包络里，让空间"有空气"
    const N = 340;
    const pos = new Float32Array(N * 3);
    const seed = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      pos[i * 3] = -6.5 + Math.random() * 15;
      pos[i * 3 + 1] = -1.3 + Math.random() * 2.4;
      pos[i * 3 + 2] = -1.2 + Math.random() * 2.4;
      seed[i] = Math.random() * 6.28;
    }
    const dg = new T.BufferGeometry();
    dg.setAttribute('position', new T.BufferAttribute(pos, 3));
    this.innerDust = new T.Points(dg, new T.PointsMaterial({
      color: 0xaef0ff, size: 0.045, transparent: true, opacity: 0.0,
      depthWrite: false, blending: T.AdditiveBlending, sizeAttenuation: true
    }));
    this.innerDust.userData.seed = seed;
    s.add(this.innerDust);
  };

  /* ---------------- 机体 ---------------- */
  CyberJet.prototype._buildShip = function () {
    const ship = CJ.buildShip();
    this.ship = ship;
    this.scene.add(ship.root);

    this.mats = ship.mats;

    // 记录可高亮材质的原始自发光
    this.hlMap = {
      hull: [this.mats.hullShell],
      wing: [this.mats.hullWing],
      cockpit: [this.mats.glass],
      frame: [this.mats.frame, this.mats.frameHot],
      cabin: [this.mats.seat, this.mats.seatHot, this.mats.floor],
      avionics: [this.mats.rack],
      engine: [this.mats.engineShell],
      gear: [this.mats.metal, this.mats.rubber],
      fuel: [this.mats.tank, this.mats.tankBand],
      conduit: [this.mats.conduit],
      core: [this.mats.coreRing, this.mats.coreCage]
    };
    this._orig = new Map();
    Object.keys(this.hlMap).forEach((k) => {
      this.hlMap[k].forEach((m) => {
        if (m && !this._orig.has(m)) {
          this._orig.set(m, {
            color: m.emissive ? m.emissive.clone() : null,
            intensity: m.emissiveIntensity !== undefined ? m.emissiveIntensity : 1
          });
        }
      });
    });

    // 内部结构默认隐藏
    ship.internals.visible = false;

    // 扫描光幕
    this.beam = new T.Mesh(
      new T.PlaneGeometry(11, 9),
      new T.MeshBasicMaterial({
        map: beamTexture(), color: 0x8ff8ff, transparent: true, opacity: 0.0,
        blending: T.AdditiveBlending, depthWrite: false, side: T.DoubleSide
      })
    );
    this.beam.rotation.y = Math.PI / 2;
    this.beam.position.set(14, 0.6, 0);
    this.scene.add(this.beam);
    this.beamOn = false;

    // 分解引线：从机身脊线连到抬起的上盖
    const N = ship.anchors.length;
    const lg = new T.BufferGeometry();
    lg.setAttribute('position', new T.BufferAttribute(new Float32Array(N * 6), 3));
    this.explodeLines = new T.LineSegments(lg, new T.LineDashedMaterial({
      color: 0x9ff8ff, transparent: true, opacity: 0,
      dashSize: 0.22, gapSize: 0.16, depthWrite: false
    }));
    this.explodeLines.visible = false;
    this.scene.add(this.explodeLines);
  };

  /* ---------------- 输入 ---------------- */
  CyberJet.prototype._bindInput = function () {
    const p = this.pointer;
    const el = this.canvas;

    const down = (x, y) => { p.down = true; p.x = x; p.y = y; p.idle = 0; };
    const up = () => { p.down = false; };

    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture && el.setPointerCapture(e.pointerId);
      down(e.clientX, e.clientY);
    });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointermove', (e) => {
      if (!p.down) { p.idle += 0.016; return; }
      const dx = e.clientX - p.x;
      const dy = e.clientY - p.y;
      p.x = e.clientX; p.y = e.clientY;
      p.idle = 0;
      this.cam.tTheta -= dx * 0.006;
      this.cam.tPhi = clamp(this.cam.tPhi - dy * 0.005, 0.16, 1.72);
      this.cam.auto = false;
    });
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.cam.tDist = clamp(this.cam.tDist * (1 + Math.sign(e.deltaY) * 0.08), 7, 60);
    }, { passive: false });

    // 触摸
    el.addEventListener('touchstart', (e) => {
      const t = e.touches[0];
      if (t) down(t.clientX, t.clientY);
    }, { passive: true });
    el.addEventListener('touchmove', (e) => {
      const t = e.touches[0];
      if (!t || !p.down) return;
      const dx = t.clientX - p.x, dy = t.clientY - p.y;
      p.x = t.clientX; p.y = t.clientY;
      this.cam.tTheta -= dx * 0.008;
      this.cam.tPhi = clamp(this.cam.tPhi - dy * 0.006, 0.16, 1.72);
    }, { passive: true });
    el.addEventListener('touchend', up, { passive: true });
  };

  /* ---------------- 交互 API ---------------- */
  CyberJet.prototype.setOpen = function (v) {
    const prev = this.openTarget;
    this.openTarget = clamp(v, 0, 1);
    // 剖开时自动把相机抬到 3/4 俯视：水平视角只能看见一条缝，看不见甲板
    if (prev < 0.5 && this.openTarget >= 0.5 && this.cam.tPhi > 0.90) {
      this.cam.tPhi = 0.78;
      this.cam.tDist = Math.min(this.cam.tDist, 18);
      this.cam.auto = false;
    }
  };

  CyberJet.prototype.setXray = function (v) {
    this.xrayTarget = v ? 1 : 0;
  };

  CyberJet.prototype.setScan = function (on) {
    this.beamOn = !!on;
  };

  CyberJet.prototype.select = function (id) {
    this.selected = id;
    const part = CJ.PARTS.find((p) => p.id === id);
    if (part && part.focus) {
      this.cam.tTarget.set(part.focus.x, part.focus.y, part.focus.z || 0);
      this.cam.tDist = part.focus.dist;
      this.cam.auto = false;
    }
  };

  CyberJet.prototype.view = function (name) {
    this.cam.auto = false;
    this.cam.tTarget.set(0, 0, 0);
    this.cam.tDist = 30;
    if (name === 'side') { this.cam.tTheta = Math.PI / 2; this.cam.tPhi = 1.08; }
    if (name === 'front') { this.cam.tTheta = 0.02; this.cam.tPhi = 1.20; }
    if (name === 'top') { this.cam.tTheta = Math.PI / 2; this.cam.tPhi = 0.22; }
    if (name === 'hero') { this.cam.tTheta = 0.95; this.cam.tPhi = 0.86; this.cam.tDist = 30; }
  };

  CyberJet.prototype.reset = function () {
    this.cam.auto = true;
    this.cam.tTarget.set(0, 0, 0);
    this.cam.tDist = 31;
    this.cam.tTheta = 0.92;
    this.cam.tPhi = 1.12;
    this.openTarget = 0;
    this.xrayTarget = 0;
    this.selected = null;
  };

  /* ---------------- 每帧 ---------------- */
  CyberJet.prototype.resize = function () {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();

    const gw = Math.max(2, Math.round(w / 3));
    const gh = Math.max(2, Math.round(h / 3));
    this.glowCanvas.width = gw;
    this.glowCanvas.height = gh;
  };

  CyberJet.prototype.update = function (dt) {
    const c = this.cam;
    this.t += dt;

    if (this.pointer.idle > 5) c.auto = true;
    if (c.auto) c.tTheta += dt * 0.055;

    c.theta = lerp(c.theta, c.tTheta, 1 - Math.pow(0.0015, dt));
    c.phi = lerp(c.phi, c.tPhi, 1 - Math.pow(0.0015, dt));
    c.dist = lerp(c.dist, c.tDist, 1 - Math.pow(0.002, dt));
    c.target.lerp(c.tTarget, 1 - Math.pow(0.0025, dt));

    const sp = Math.sin(c.phi), cp = Math.cos(c.phi);
    this.camera.position.set(
      c.target.x + c.dist * sp * Math.cos(c.theta),
      c.target.y + c.dist * cp,
      c.target.z + c.dist * sp * Math.sin(c.theta)
    );
    this.camera.lookAt(c.target);

    // 剖开
    this.open = lerp(this.open, this.openTarget, 1 - Math.pow(0.004, dt));
    const o = this.open;
    const ship = this.ship;
    // 抬得不够高 = 没剖开。抬到 3.4 并且淡成幽灵壳，视线才能真正进舱
    ship.upperGroup.position.set(0, o * 3.4, o * 0.9);
    ship.upperGroup.rotation.z = o * 0.02;
    ship.lowerGroup.position.y = -o * 0.45;
    ship.internals.visible = o > 0.015 || this.xray > 0.35;

    /* 上盖处理：实心蒙皮直接退场，只把"线框轮廓"留在空中。
       半透明的实心壳永远在抢视线，退干净之后内部才真正成为主角。 */
    if (ship.upSolid) {
      const solid = 1 - Math.min(1, o / 0.5);
      for (const m of ship.upSolid) {
        if (!m) continue;
        m.opacity = solid;
        m.transparent = solid < 0.995;
        m.depthWrite = solid > 0.9;
        m.visible = solid > 0.012;
      }
      const wr = Math.min(1, o / 0.6);
      for (const m of ship.upWire) {
        if (!m) continue;
        m.opacity = 0.05 + 0.16 * wr;
      }
    }

    // 机翼退成幽灵，否则俯视时整个剖面被机翼盖住
    if (ship.wingFade) {
      const wf = Math.max(0, Math.min(1, (o - 0.32) / 0.5));
      const wo = 1 - wf * 0.90;
      for (const m of ship.wingFade) {
        if (!m || m.opacity === undefined) continue;
        m.opacity = wo;
        m.transparent = wo < 0.995;
        m.depthWrite = wo > 0.9;
      }
    }

    // 分解引线
    const eo = o;
    if (eo > 0.04) {
      this.explodeLines.visible = true;
      const arr = this.explodeLines.geometry.attributes.position.array;
      const A = ship.anchors;
      for (let i = 0; i < A.length; i++) {
        arr[i * 6] = A[i].x; arr[i * 6 + 1] = A[i].y; arr[i * 6 + 2] = 0;
        arr[i * 6 + 3] = A[i].x;
        arr[i * 6 + 4] = A[i].y + eo * 3.4;
        arr[i * 6 + 5] = eo * 0.9;
      }
      this.explodeLines.geometry.attributes.position.needsUpdate = true;
      this.explodeLines.geometry.computeBoundingSphere();
      this.explodeLines.computeLineDistances();
      this.explodeLines.material.opacity = 0.9 * Math.min(1, eo * 2.2);
    } else {
      this.explodeLines.visible = false;
    }

    // X 光
    this.xray = lerp(this.xray, this.xrayTarget, 1 - Math.pow(0.01, dt));
    const xr = this.xray;
    const glassy = xr > 0.02;
    const hs = this.mats.hullShell;
    hs.transparent = glassy;
    hs.opacity = 1 - xr * 0.9;
    hs.depthWrite = !glassy || xr < 0.5;
    this.mats.hullWing.opacity = 1 - xr * 0.55;
    this.mats.hullWing.transparent = glassy;

    if (this.xray > 0.2) ship.internals.visible = true;

    // 舱内灯随剖开程度亮起
    const lit = Math.max(o, this.xray * 0.85);
    this.cabinLightA.intensity = lit * 1.9;
    this.cabinLightB.intensity = lit * 1.55;
    this.coreLight.intensity = lit * (4.2 + 0.9 * Math.sin(this.t * 2.3));
    this.coreLight2.intensity = lit * 2.6;
    this.tankLight.intensity = lit * 1.5;
    this.cargoLight.intensity = lit * 1.2;

    // 体积光锥：只有掀开上盖才有资格出现
    for (let i = 0; i < this.shafts.length; i++) {
      const m = this.shafts[i];
      const u = m.material.uniforms.uOpacity;
      u.value = lerp(u.value, lit * (0.07 + i * 0.008), 1 - Math.pow(0.02, dt));
      m.visible = u.value > 0.002;
      m.rotation.y = this.t * 0.06 * (i % 2 ? 1 : -1);
    }

    // 舱内浮尘
    if (this.innerDust) {
      const dm = this.innerDust.material;
      dm.opacity = lerp(dm.opacity, lit * 0.55, 1 - Math.pow(0.03, dt));
      this.innerDust.visible = dm.opacity > 0.01;
      this.innerDust.position.y = Math.sin(this.t * 0.25) * 0.05;
    }

    // 动力核心：环体旋转 + 辉光呼吸
    if (ship.spin) {
      for (const m of ship.spin) {
        const ax = m.userData.spinAxis || 'z';
        m.rotation[ax] += dt * (m.userData.spinSpeed || 0.6);
      }
    }
    if (ship.coreGlow) {
      const p = 0.84 + 0.16 * Math.sin(this.t * 2.4);
      const g0 = ship.coreGlow[0], g1 = ship.coreGlow[1];
      g0.scale.set(1.8 * p, 1.8 * p, 1);
      g1.scale.set(3.4 * (2 - p), 3.4 * (2 - p), 1);
      g0.material.opacity = 0.45 + lit * 0.55;
      g1.material.opacity = 0.12 + lit * 0.42;
      g0.visible = lit > 0.02;
      g1.visible = lit > 0.02;
    }

    // 全息标注：剖开到一定程度才浮出来
    if (ship.labels) {
      const la = Math.max(0, Math.min(1, (lit - 0.30) / 0.55)) * 0.92;
      for (const m of ship.labels) m.opacity = la;
    }

    // 高亮
    const part = this.selected;
    Object.keys(this.hlMap).forEach((k) => {
      const on = k === part;
      this.hlMap[k].forEach((m) => {
        if (!m || !m.emissive) return;
        const o0 = this._orig.get(m);
        if (!o0) return;
        const pulse = 0.6 + 0.4 * Math.sin(this.t * 4.2);
        if (on) {
          const col = CJ.PARTS.find((p) => p.id === k);
          m.emissive.setHex(col ? col.color : 0x2ad0ff);
          m.emissiveIntensity = 0.32 + pulse * 0.55;
        } else {
          m.emissive.copy(o0.color);
          m.emissiveIntensity = o0.intensity;
        }
      });
    });

    // 扫描光幕
    const beamMat = this.beam.material;
    const wantOp = this.beamOn ? 0.55 : 0;
    beamMat.opacity = lerp(beamMat.opacity, wantOp, 1 - Math.pow(0.02, dt));
    if (beamMat.opacity > 0.005) {
      const span = 22;
      const p = ((this.t * 0.35) % 1);
      this.beam.position.x = 12 - p * span;
      this.beam.position.y = 0.6;
    }

    // 引擎喷口脉动
    const navColors = [0xff3d7f, 0x2ad0ff];
    this.ship.engines.children.forEach((eng, i) => {
      const plume = eng.userData.plume;
      if (plume) {
        const f = 0.55 + 0.45 * Math.abs(Math.sin(this.t * (2.1 + i * 0.3) + i));
        plume.material.opacity = 0.35 + f * 0.5;
        const s = 0.8 + f * 0.5;
        plume.scale.set(s, s, s);
      }
    });

    // 尘埃缓慢上浮
    if (this.dust) this.dust.rotation.y = this.t * 0.012;
  };

  CyberJet.prototype.render = function () {
    this.renderer.render(this.scene, this.camera);

    // 廉价泛光：把主画布缩到 1/3 再叠一层 CSS 模糊
    const g = this.glowCanvas;
    this.glowCtx.clearRect(0, 0, g.width, g.height);
    this.glowCtx.drawImage(this.canvas, 0, 0, g.width, g.height);
  };

  CyberJet.prototype.start = function () {
    const loop = () => {
      this._raf = requestAnimationFrame(loop);
      const dt = Math.min(0.05, this.clock.getDelta());

      this._fpsAcc += dt; this._fpsN++;
      if (this._fpsAcc >= 0.5) {
        this.fps = this._fpsN / this._fpsAcc;
        this._fpsAcc = 0; this._fpsN = 0;
      }

      if (document.hidden) return;
      this.update(dt);
      this.render();
    };
    loop();
  };

  CJ.CyberJet = CyberJet;
})();
