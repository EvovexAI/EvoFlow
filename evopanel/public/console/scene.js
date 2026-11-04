/* =========================================================
   EvoFlow Console · 中枢指挥台（2D 赛博朋克讲解页）
   中央：AI 对话指挥屏（真实对话流 + 任务派发动画）
   周围：六块模块屏，每屏都是一段可读的实时演示
   ========================================================= */
(function () {
  'use strict';

  const U = CN.utils;
  const P = U.P;

  /* ---------------- 文案（页面想表达的全部内容） ---------------- */
  const TAGLINE = 'EvoFlow —— 一个对话框指挥所有系统：你说需求，AI 拆解任务、派发模块、汇总结果。';

  const CAPTIONS = {
    core: '「对话指挥台」你说一句话，AI 负责拆解、派发、汇报——不用挨个打开工具。',
    tasks: '「任务中心」所有事项一块看板：待办 / 进行中 / 已完成，进度实时可查。',
    flow: '「工作流」把重复工作画成流程图，一次搭建，之后每次自动运行。',
    agents: '「智能体员工」写手、分析师、助理各司其职，像同事一样接活干活。',
    knowledge: '「知识库」团队资料统一沉淀，AI 的回答有据可查。',
    auto: '「自动化」定时任务自动触发，你不盯屏幕，事情也在推进。',
    plugins: '「扩展应用」接入自定义工作台、自定义 Agent 与 AI 应用，能力持续生长。'
  };

  // 中央对话脚本（循环播放），dispatch = 触发哪块模块屏的数据脉冲
  const SCRIPT = [
    { who: 'u', text: '把昨天的周报整理成简报，发给项目群，再设个周五提醒', dur: 4.4 },
    { who: 'a', text: '收到 · 已拆解为 3 步，开始派发 →', dur: 2.8, dispatch: ['flow', 'tasks'] },
    { who: 'a', text: '① 从知识库调取《周报-1028》', dur: 3.0, dispatch: ['knowledge'] },
    { who: 'a', text: '② 简报生成完毕（智能体·写手 交付）', dur: 3.2, dispatch: ['agents'] },
    { who: 'a', text: '③ 已发送至项目群 · 周五提醒已创建', dur: 3.4, dispatch: ['auto'] },
    { who: 'a', text: '✓ 全部完成，用时 26 秒', dur: 3.4 }
  ];

  /* ---------------- 布局（世界坐标 1600 × 900） ---------------- */
  const CORE = { id: 'core', title: '对话指挥台', en: 'AI CONSOLE', color: P.cyan, rect: [545, 108, 510, 600] };

  const MODS = [
    { id: 'tasks',     title: '任务中心',   en: 'TASK CENTER', color: P.amber,   rect: [42, 118, 402, 222] },
    { id: 'flow',      title: '工作流',     en: 'WORKFLOW',    color: P.magenta, rect: [42, 368, 402, 242] },
    { id: 'auto',      title: '自动化',     en: 'AUTOMATION',  color: P.lime,    rect: [42, 618, 402, 214] },
    { id: 'agents',    title: '智能体员工', en: 'AI AGENTS',   color: P.purple,  rect: [1156, 118, 402, 222] },
    { id: 'knowledge', title: '知识库',     en: 'KNOWLEDGE',   color: P.ice,     rect: [1156, 368, 402, 242] },
    { id: 'plugins',   title: '扩展应用',   en: 'PLUGINS',     color: '#4f8dff', rect: [1156, 618, 402, 214] }
  ];

  const ALL = [CORE].concat(MODS);
  const byId = {};
  ALL.forEach((m) => { byId[m.id] = m; });

  /* ---------------- 字体 ---------------- */
  const F = (size, weight) =>
    (weight || 400) + ' ' + size + 'px "Cascadia Code", Consolas, "Microsoft YaHei", "PingFang SC", sans-serif';

  /* =========================================================
     场景
     ========================================================= */
  class ConsoleScene {
    constructor(engine) {
      this.eng = engine;
      this.W = engine.w;
      this.H = engine.h;

      this.tl = 0;                 // 本地时间
      this.scriptT = 0;            // 对话脚本推进
      this.lineIdx = 0;
      this.lineAge = 0;
      this.dispatched = {};        // 本轮已派发标记
      this.cycle = 0;

      this.pulses = [];            // 总线脉冲
      this._ambientIn = 2.2;

      this.coreFlash = 0;

      // 相机
      this.cam = { x: 800, y: 455, z: 1 };
      this.camT = { x: 800, y: 455, z: 1 };
      this.sel = null;

      this.mods = ALL;
    }

    resize(w, h) {
      this.W = w;
      this.H = h;
      this.S = Math.min(w / 1600, h / 900);
    }

    /* 相机聚焦 */
    focus(id) {
      this.sel = id;
      if (!id) {
        this.camT = { x: 800, y: 460, z: 1 };
        return;
      }
      const r = byId[id].rect;
      const cx = r[0] + r[2] / 2;
      const cy = r[1] + r[3] / 2;
      // 宽高都装得下才完整：取两方向的最紧 zoom
      const zw = (this.W / this.S) * 0.56 / r[2];
      const zh = (this.H / this.S) * 0.68 / r[3];
      const z = U.clamp(Math.min(zw, zh), 1.35, 2.6);
      // 相机目标下移一点，补偿底部字幕条占的高度
      const shift = ((this.H / this.S) / z) * 0.045;
      this.camT = { x: cx, y: cy + shift, z };
    }

    /* 屏幕坐标 → 世界坐标 */
    screenToWorld(sx, sy) {
      const k = this.S * this.cam.z;
      return {
        x: (sx - this.W / 2) / k + this.cam.x,
        y: (sy - this.H / 2) / k + this.cam.y
      };
    }

    hitTest(sx, sy) {
      const p = this.screenToWorld(sx, sy);
      for (const m of ALL) {
        const r = m.rect;
        if (p.x >= r[0] && p.x <= r[0] + r[2] && p.y >= r[1] && p.y <= r[1] + r[3]) return m.id;
      }
      return null;
    }

    onPointerDown(sx, sy) {
      const id = this.hitTest(sx, sy);
      if (id && id !== this.sel) {
        window.dispatchEvent(new CustomEvent('ef:select', { detail: { id, user: true } }));
      } else if (!id && this.sel) {
        window.dispatchEvent(new CustomEvent('ef:select', { detail: { id: null, user: true } }));
      }
    }

    /* 派发一条总线脉冲 */
    dispatch(modId, strong) {
      const m = byId[modId];
      if (!m) return;
      const r = m.rect;
      const left = r[0] + r[2] / 2 < 800;
      const y0 = 700;
      const ym = Math.min(r[1] + r[3] / 2, 742);
      const midX = left ? 497 : 1103;
      const path = [
        [800, y0],
        [midX, y0],
        [midX, ym],
        [left ? r[0] + r[2] : r[0], ym]
      ];
      this.pulses.push({ path, age: 0, life: 1.15, color: m.color, strong: !!strong });
      this.coreFlash = 1;
    }

    /* ---------------- 更新 ---------------- */
    update(dt, t) {
      this.tl += dt;

      // 相机平滑
      const k = U.damp(dt, 3.4);
      this.cam.x += (this.camT.x - this.cam.x) * k;
      this.cam.y += (this.camT.y - this.cam.y) * k;
      this.cam.z += (this.camT.z - this.cam.z) * k;

      this.coreFlash = Math.max(0, this.coreFlash - dt * 2.2);

      // 对话脚本
      this.scriptT += dt;
      this._lineClock = (this._lineClock || 0) + dt;
      const line = SCRIPT[this.lineIdx];
      if (line) {
        const typeDur = line.text.length * 0.045 + 0.25;
        const lineDur = Math.max(typeDur + 0.9, line.dur);

        // 该行触发的派发（打字过半时）
        if (line.dispatch && this._lineClock > typeDur * 0.7) {
          for (const d of line.dispatch) {
            if (!this.dispatched[this.cycle + ':' + d]) {
              this.dispatched[this.cycle + ':' + d] = true;
              this.dispatch(d, true);
            }
          }
        }

        if (this._lineClock >= lineDur) {
          this._lineClock = 0;
          this.lineIdx++;
          if (this.lineIdx >= SCRIPT.length) {
            this.lineIdx = 0;
            this.cycle++;
            this.dispatched = {};
          }
        }
      }

      // 氛围脉冲
      this._ambientIn -= dt;
      if (this._ambientIn <= 0) {
        this._ambientIn = 2.6 + Math.random() * 2.4;
        this.dispatch(U.pick(MODS).id, false);
      }

      // 脉冲寿命
      for (let i = this.pulses.length - 1; i >= 0; i--) {
        this.pulses[i].age += dt;
        if (this.pulses[i].age > this.pulses[i].life) this.pulses.splice(i, 1);
      }
    }

    /* ---------------- 绘制 ---------------- */
    draw(ctx) {
      const { W, H } = this;
      this.drawBackground(ctx);

      ctx.save();
      const kk = this.S * this.cam.z;
      ctx.translate(W / 2, H / 2);
      ctx.scale(kk, kk);
      ctx.translate(-this.cam.x, -this.cam.y);

      this.drawWorldGrid(ctx);
      this.drawConduits(ctx);

      for (const m of MODS) this.drawModule(ctx, m);
      this.drawCore(ctx);
      this.drawPulses(ctx);
      this.drawFloorGlow(ctx);

      ctx.restore();
    }

    /* ---- 背景（屏幕空间 + 视差） ---- */
    drawBackground(ctx) {
      const { W, H, eng } = this;
      const px = eng.pointer.sx, py = eng.pointer.sy;

      const bg = ctx.createLinearGradient(0, 0, 0, H);
      bg.addColorStop(0, '#070418');
      bg.addColorStop(0.55, '#04030c');
      bg.addColorStop(1, '#02010a');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, W, H);

      // 顶部光带
      ctx.globalCompositeOperation = 'lighter';
      U.drawStreak(ctx, P.cyan, W * 0.5 - px * 18, -40, W * 0.9, 190, 0.10);
      U.drawStreak(ctx, P.purple, W * 0.18 - px * 30, -60, W * 0.5, 150, 0.07);
      U.drawStreak(ctx, P.magenta, W * 0.84 - px * 26, -50, W * 0.45, 150, 0.06);
      ctx.globalCompositeOperation = 'source-over';
    }

    /* ---- 世界网格地板 ---- */
    drawWorldGrid(ctx) {
      ctx.save();
      ctx.strokeStyle = 'rgba(80,140,220,0.10)';
      ctx.lineWidth = 1;
      for (let x = -400; x <= 2000; x += 80) {
        ctx.beginPath(); ctx.moveTo(x, 892); ctx.lineTo(x, 1050); ctx.stroke();
      }
      let yy = 892, gap = 10;
      while (yy < 1080) {
        ctx.beginPath(); ctx.moveTo(-400, yy); ctx.lineTo(2000, yy); ctx.stroke();
        yy += gap; gap *= 1.32;
      }
      ctx.restore();
    }

    /* ---- 总线导管 ---- */
    conduitPath(m) {
      const r = m.rect;
      const left = r[0] + r[2] / 2 < 800;
      const y0 = 700;
      const ym = Math.min(r[1] + r[3] / 2, 742);
      const midX = left ? 497 : 1103;
      return [
        [800, y0],
        [midX, y0],
        [midX, ym],
        [left ? r[0] + r[2] : r[0], ym]
      ];
    }

    drawConduits(ctx) {
      for (const m of MODS) {
        const pts = this.conduitPath(m);
        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
        ctx.strokeStyle = 'rgba(70,90,140,0.35)';
        ctx.lineWidth = 5;
        ctx.stroke();
        ctx.strokeStyle = U.rgba(m.color, 0.16);
        ctx.lineWidth = 1.6;
        ctx.stroke();
      }
    }

    /* ---- 脉冲 ---- */
    drawPulses(ctx) {
      ctx.globalCompositeOperation = 'lighter';
      for (const pl of this.pulses) {
        const k = pl.age / pl.life;
        const segs = [];
        let total = 0;
        for (let i = 1; i < pl.path.length; i++) {
          const dx = pl.path[i][0] - pl.path[i - 1][0];
          const dy = pl.path[i][1] - pl.path[i - 1][1];
          const len = Math.hypot(dx, dy);
          segs.push({ a: pl.path[i - 1], b: pl.path[i], len, start: total });
          total += len;
        }
        const d = k * total;
        let pos = null;
        for (const s of segs) {
          if (d >= s.start && d <= s.start + s.len) {
            const t = (d - s.start) / s.len;
            pos = [U.lerp(s.a[0], s.b[0], t), U.lerp(s.a[1], s.b[1], t)];
            break;
          }
        }
        if (!pos) continue;
        const alpha = (pl.strong ? 0.9 : 0.4) * Math.sin(Math.PI * Math.min(1, k * 1.15));
        U.drawGlow(ctx, pl.color, pos[0], pos[1], pl.strong ? 30 : 16, alpha, 0.28);
        U.drawGlow(ctx, '#ffffff', pos[0], pos[1], pl.strong ? 10 : 6, alpha * 0.8, 0.3);
      }
      ctx.globalCompositeOperation = 'source-over';
    }

    /* ---- 地面光晕 ---- */
    drawFloorGlow(ctx) {
      ctx.globalCompositeOperation = 'lighter';
      const fl = this.coreFlash;
      U.drawStreak(ctx, P.cyan, 800, 906, 900 + fl * 260, 120, 0.10 + fl * 0.08);
      ctx.globalCompositeOperation = 'source-over';
    }

    /* =========================================================
        屏幕公共外框
       ========================================================= */
    drawScreenFrame(ctx, r, color, title, en, active, ledOn) {
      const [x, y, w, h] = r;

      // 选中辉光
      if (active) {
        ctx.globalCompositeOperation = 'lighter';
        U.drawStreak(ctx, color, x + w / 2, y + h / 2, w * 1.45, h * 1.7, 0.14);
        ctx.globalCompositeOperation = 'source-over';
      }

      // 面板
      ctx.fillStyle = 'rgba(7,10,22,0.93)';
      U.roundRect(ctx, x, y, w, h, 8);
      ctx.fill();
      ctx.strokeStyle = U.rgba(color, active ? 0.9 : 0.42);
      ctx.lineWidth = active ? 2 : 1.2;
      ctx.stroke();

      // 内描边（暗）
      ctx.strokeStyle = 'rgba(120,160,220,0.08)';
      ctx.lineWidth = 1;
      U.roundRect(ctx, x + 4, y + 4, w - 8, h - 8, 5);
      ctx.stroke();

      // 标题栏
      ctx.fillStyle = U.rgba(color, active ? 0.16 : 0.08);
      ctx.fillRect(x, y, w, 30);
      ctx.fillStyle = color;
      ctx.fillRect(x, y, 4, 30);
      ctx.font = F(15, 700);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = U.rgba(color, 0.95);
      ctx.fillText(title, x + 16, y + 15.5);
      ctx.font = F(10, 500);
      ctx.fillStyle = 'rgba(150,180,220,0.5)';
      ctx.textAlign = 'right';
      ctx.fillText(en, x + w - 34, y + 15.5);

      // 状态 LED
      const led = ledOn === false ? 'rgba(120,140,170,0.4)' : color;
      ctx.beginPath();
      ctx.arc(x + w - 16, y + 15, 3.4, 0, U.TAU);
      ctx.fillStyle = led;
      ctx.fill();
      if (ledOn !== false) {
        ctx.globalCompositeOperation = 'lighter';
        U.drawGlow(ctx, color, x + w - 16, y + 15, 14, 0.5, 0.3);
        ctx.globalCompositeOperation = 'source-over';
      }

      // 选中角标
      if (active) {
        ctx.strokeStyle = color;
        ctx.lineWidth = 2.4;
        const B = 14, o = -5;
        const corners = [
          [x + o, y + o, 1, 1], [x + w - o, y + o, -1, 1],
          [x + o, y + h - o, 1, -1], [x + w - o, y + h - o, -1, -1]
        ];
        for (const [cx, cy, dx, dy] of corners) {
          ctx.beginPath();
          ctx.moveTo(cx + dx * B, cy);
          ctx.lineTo(cx, cy);
          ctx.lineTo(cx, cy + dy * B);
          ctx.stroke();
        }
      }
    }

    clipContent(ctx, r, fn) {
      ctx.save();
      U.roundRect(ctx, r[0] + 6, r[1] + 34, r[2] - 12, r[3] - 40, 4);
      ctx.clip();
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      fn();
      ctx.restore();
    }

    /* =========================================================
        各模块内容
       ========================================================= */
    drawModule(ctx, m) {
      const active = this.sel === m.id;
      this.drawScreenFrame(ctx, m.rect, m.color, m.title, m.en, active, true);
      const r = m.rect;
      this.clipContent(ctx, r, () => this['draw_' + m.id](ctx, r, active));
    }

    /* ---- 任务中心 ---- */
    draw_tasks(ctx, r, active) {
      const x = r[0] + 14, y = r[1] + 44, w = r[2] - 28;
      const cols = ['待办', '进行中', '已完成'];
      const cw = w / 3;
      ctx.font = F(11, 700);
      for (let i = 0; i < 3; i++) {
        const cx = x + i * cw;
        ctx.fillStyle = 'rgba(150,180,220,0.55)';
        ctx.fillText(cols[i] + ' · ' + [2, 1, 4][i], cx + 2, y + 8);
        ctx.strokeStyle = 'rgba(140,170,220,0.14)';
        ctx.beginPath();
        ctx.moveTo(cx, y + 16); ctx.lineTo(cx + cw - 10, y + 16);
        ctx.stroke();
      }

      const card = (cx, cy, cwid, title, pct, col, dim) => {
        ctx.globalAlpha = dim ? 0.45 : 1;
        ctx.fillStyle = 'rgba(20,28,46,0.9)';
        U.roundRect(ctx, cx, cy, cwid, 34, 4);
        ctx.fill();
        ctx.strokeStyle = U.rgba(col, 0.35);
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.font = F(11, 500);
        ctx.fillStyle = 'rgba(210,230,250,0.9)';
        ctx.fillText(title, cx + 8, cy + 14);
        if (pct != null) {
          ctx.fillStyle = 'rgba(255,255,255,0.07)';
          ctx.fillRect(cx + 8, cy + 24, cwid - 16, 4);
          ctx.fillStyle = col;
          ctx.fillRect(cx + 8, cy + 24, (cwid - 16) * pct, 4);
        }
        ctx.globalAlpha = 1;
      };

      const cw2 = cw - 10;
      // 静态卡
      card(x, y + 26, cw2, '整理会议纪要', null, P.amber, true);
      card(x, y + 66, cw2, '周报汇总', null, P.amber, true);
      card(x + cw, y + 26, cw2, '客户FAQ整理', 0.62, P.amber);
      card(x + cw * 2, y + 26, cw2, '✓ 发送项目简报', 1, 'rgba(120,220,150,0.8)', true);
      card(x + cw * 2, y + 66, cw2, '✓ 数据日报', 1, 'rgba(120,220,150,0.8)', true);

      // 动画卡：周报简报 在三列间流转
      const phase = (this.tl / 5) % 3;
      const colIdx = Math.floor(phase);
      const ft = phase - colIdx;
      const ease = ft * ft * (3 - 2 * ft);
      const fromX = x + colIdx * cw;
      const toX = x + Math.min(2, colIdx + 1) * cw;
      const gx = U.lerp(fromX, toX, colIdx === 2 ? 0 : ease);
      const done = colIdx === 2;
      const glow = colIdx === 1 ? 1 : 0.35;
      ctx.globalCompositeOperation = 'lighter';
      U.drawGlow(ctx, done ? 'rgba(120,220,150,1)' : P.amber, gx + cw2 / 2, y + 143, 90, 0.12 * glow, 0.3);
      ctx.globalCompositeOperation = 'source-over';
      card(gx, y + 126, cw2, done ? '✓ 周报简报' : '周报简报', done ? 1 : colIdx === 1 ? ease : null,
        done ? 'rgba(120,220,150,0.8)' : P.amber);
    }

    /* ---- 工作流 ---- */
    draw_flow(ctx, r, active) {
      const x = r[0] + 20, y = r[1] + 92, w = r[2] - 40;
      const names = ['触发', '解析', '生成', '校验', '交付'];
      const n = names.length;
      const xs = [];
      for (let i = 0; i < n; i++) xs.push(x + (w / (n - 1)) * i);

      // 触发说明
      ctx.font = F(11, 500);
      ctx.fillStyle = 'rgba(150,180,220,0.55)';
      ctx.fillText('手动 / 定时 / Webhook 触发', x, r[1] + 56);

      // 连线
      ctx.strokeStyle = U.rgba(P.magenta, 0.30);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(xs[0], y);
      for (let i = 1; i < n; i++) ctx.lineTo(xs[i], y);
      ctx.stroke();

      // 脉冲
      const cyc = (this.tl * 0.28) % 1.25;
      for (let i = 0; i < n - 1; i++) {
        const seg = cyc * (n - 1) - i;
        if (seg >= 0 && seg <= 1) {
          const px = U.lerp(xs[i], xs[i + 1], seg);
          ctx.globalCompositeOperation = 'lighter';
          U.drawGlow(ctx, P.magenta, px, y, 26, 0.8, 0.3);
          ctx.globalCompositeOperation = 'source-over';
        }
      }

      // 节点
      const lit = Math.floor(cyc * (n - 1) + 0.999);
      for (let i = 0; i < n; i++) {
        const on = i <= lit || cyc >= 1.2;
        ctx.beginPath();
        ctx.arc(xs[i], y, 11, 0, U.TAU);
        ctx.fillStyle = '#0a0f1e';
        ctx.fill();
        ctx.strokeStyle = U.rgba(P.magenta, on ? 0.95 : 0.35);
        ctx.lineWidth = 2;
        ctx.stroke();
        if (on) {
          ctx.globalCompositeOperation = 'lighter';
          U.drawGlow(ctx, P.magenta, xs[i], y, 30, 0.4, 0.3);
          ctx.globalCompositeOperation = 'source-over';
          ctx.fillStyle = U.rgba(P.magenta, 0.9);
        } else {
          ctx.fillStyle = 'rgba(150,170,210,0.4)';
        }
        ctx.beginPath();
        ctx.arc(xs[i], y, 4, 0, U.TAU);
        ctx.fill();

        ctx.font = F(12, on ? 700 : 500);
        ctx.textAlign = 'center';
        ctx.fillStyle = on ? 'rgba(230,240,255,0.92)' : 'rgba(160,185,220,0.55)';
        ctx.fillText(names[i], xs[i], y + 34);
        ctx.textAlign = 'left';
      }

      // 底部说明
      ctx.font = F(11, 500);
      ctx.fillStyle = 'rgba(150,180,220,0.5)';
      ctx.fillText('节点 = 一步操作：调用 AI · 查询 · 发送 · 审批', x, r[1] + r[3] - 44);
      ctx.fillStyle = U.rgba(P.magenta, 0.75);
      ctx.fillText('运行 ' + (1240 + Math.floor(this.tl)) + ' 次 · 成功率 99.2%', x, r[1] + r[3] - 24);
    }

    /* ---- 自动化 ---- */
    draw_auto(ctx, r, active) {
      const x = r[0] + 16, y = r[1] + 50;
      const rows = [
        ['每天 09:00', '晨间简报 → 推送项目群'],
        ['每周五 17:00', '周报归档 → 知识库'],
        ['每天 18:30', '未办事项提醒 → 企业微信']
      ];
      rows.forEach((row, i) => {
        const ry = y + i * 44;
        const fire = (this.tl + i * 3.1) % 9 < 0.35;
        ctx.fillStyle = fire ? U.rgba(P.lime, 0.10) : 'rgba(20,28,46,0.85)';
        U.roundRect(ctx, x, ry, r[2] - 32, 38, 4);
        ctx.fill();
        ctx.strokeStyle = U.rgba(P.lime, fire ? 0.9 : 0.22);
        ctx.lineWidth = 1;
        ctx.stroke();

        ctx.font = F(13, 700);
        ctx.fillStyle = U.rgba(P.lime, 0.9);
        ctx.fillText(row[0], x + 12, ry + 16);
        ctx.font = F(11, 500);
        ctx.fillStyle = 'rgba(200,225,245,0.78)';
        ctx.fillText(row[1], x + 12, ry + 31);

        ctx.beginPath();
        ctx.arc(x + r[2] - 46, ry + 19, 3.5, 0, U.TAU);
        ctx.fillStyle = fire ? '#ffffff' : P.lime;
        ctx.fill();
        if (fire) {
          ctx.globalCompositeOperation = 'lighter';
          U.drawGlow(ctx, P.lime, x + r[2] - 46, ry + 19, 26, 0.8, 0.3);
          ctx.globalCompositeOperation = 'source-over';
        }
      });

      // 倒计时
      const sec = 3600 * 4 + 60 * 31 - Math.floor(this.tl) % (3600 * 4);
      const hh = String(Math.floor(sec / 3600)).padStart(2, '0');
      const mm = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
      const ss = String(sec % 60).padStart(2, '0');
      ctx.font = F(12, 600);
      ctx.fillStyle = 'rgba(150,180,220,0.6)';
      ctx.fillText('距下次触发', x, r[1] + r[3] - 16);
      ctx.font = F(14, 700);
      ctx.fillStyle = U.rgba(P.lime, 0.95);
      ctx.fillText(hh + ':' + mm + ':' + ss, x + 86, r[1] + r[3] - 16);
    }

    /* ---- 智能体员工 ---- */
    draw_agents(ctx, r, active) {
      const x = r[0] + 14, y = r[1] + 46;
      const agents = [
        ['写手 Writer', '撰写简报中', true, P.purple],
        ['分析师 Analyst', '空闲 · 待命', false, P.cyan],
        ['助理 Assistant', '等待派单', false, P.amber]
      ];
      const cw = (r[2] - 28 - 16) / 3;
      agents.forEach((a, i) => {
        const ax = x + i * (cw + 8);
        const ay = y;
        ctx.fillStyle = 'rgba(20,26,46,0.9)';
        U.roundRect(ctx, ax, ay, cw, 118, 5);
        ctx.fill();
        ctx.strokeStyle = U.rgba(a[3], a[2] ? 0.55 : 0.25);
        ctx.lineWidth = 1;
        ctx.stroke();

        // 头像
        ctx.beginPath();
        ctx.arc(ax + cw / 2, ay + 30, 15, 0, U.TAU);
        ctx.fillStyle = U.rgba(a[3], 0.14);
        ctx.fill();
        ctx.strokeStyle = U.rgba(a[3], 0.7);
        ctx.stroke();
        ctx.font = F(13, 700);
        ctx.textAlign = 'center';
        ctx.fillStyle = U.rgba(a[3], 0.95);
        ctx.fillText(a[0][0], ax + cw / 2, ay + 35);

        // 名字
        ctx.font = F(12, 700);
        ctx.fillStyle = 'rgba(225,238,255,0.92)';
        ctx.fillText(a[0], ax + cw / 2, ay + 64);
        ctx.textAlign = 'left';

        // 状态（打字光标）
        ctx.font = F(10.5, 500);
        const cur = a[2] && Math.floor(this.tl * 2.4) % 2 === 0 ? '▌' : '';
        ctx.fillStyle = a[2] ? U.rgba(a[3], 0.9) : 'rgba(150,175,210,0.55)';
        ctx.fillText(a[1] + cur, ax + 10, ay + 86);

        // 活跃度条
        ctx.fillStyle = 'rgba(255,255,255,0.06)';
        ctx.fillRect(ax + 10, ay + 98, cw - 20, 4);
        if (a[2]) {
          const wv = 0.35 + 0.3 * Math.sin(this.tl * 3 + i);
          ctx.fillStyle = a[3];
          ctx.fillRect(ax + 10, ay + 98, (cw - 20) * Math.max(0.15, wv), 4);
        }
      });

      ctx.font = F(11, 500);
      ctx.fillStyle = 'rgba(150,180,220,0.5)';
      ctx.fillText('在岗 3 人 · 本周完成任务 27 项', x, r[1] + r[3] - 18);
    }

    /* ---- 知识库 ---- */
    draw_knowledge(ctx, r, active) {
      const x = r[0] + 16, y = r[1] + 46;
      // 搜索框
      ctx.fillStyle = 'rgba(16,24,42,0.95)';
      U.roundRect(ctx, x, y, r[2] - 32, 30, 4);
      ctx.fill();
      ctx.strokeStyle = U.rgba(P.ice, 0.4);
      ctx.stroke();
      ctx.font = F(12, 500);
      ctx.fillStyle = 'rgba(220,240,255,0.9)';
      const caret = Math.floor(this.tl * 2) % 2 === 0 ? '▌' : ' ';
      ctx.fillText('搜索: 周报' + caret, x + 12, y + 20);

      // 文件行
      const files = [
        ['周报-1028.md', 96, true],
        ['周报-1021.md', 88, true],
        ['产品FAQ.md', 42, false],
        ['会议纪要-1015.md', 31, false]
      ];
      files.forEach((f, i) => {
        const fy = y + 44 + i * 34;
        ctx.fillStyle = f[2] ? U.rgba(P.ice, 0.08) : 'rgba(18,26,44,0.8)';
        U.roundRect(ctx, x, fy, r[2] - 32, 28, 3);
        ctx.fill();
        if (f[2]) {
          ctx.strokeStyle = U.rgba(P.ice, 0.35);
          ctx.stroke();
        }
        ctx.font = F(11.5, f[2] ? 700 : 400);
        ctx.fillStyle = f[2] ? 'rgba(225,245,255,0.95)' : 'rgba(160,185,215,0.5)';
        ctx.fillText(f[0], x + 12, fy + 18);
        // 匹配度
        ctx.font = F(10.5, 600);
        ctx.fillStyle = f[2] ? U.rgba(P.ice, 0.85) : 'rgba(140,165,200,0.4)';
        ctx.textAlign = 'right';
        ctx.fillText(f[1] + '%', x + r[2] - 44, fy + 18);
        ctx.textAlign = 'left';
      });

      ctx.font = F(10.5, 500);
      ctx.fillStyle = 'rgba(150,180,220,0.5)';
      ctx.fillText('共 128 份文档 · 向量检索 0.2s', x, r[1] + r[3] - 14);
    }

    /* ---- 扩展应用：自定义工作台 + 自定义 Agent / AI 应用 ---- */
    draw_plugins(ctx, r, active) {
      const x = r[0] + 14, y = r[1] + 46;
      const cols = 2, rows = 2;
      const cw = (r[2] - 28 - 10) / cols;
      const ch = 62;
      const items = [
        ['我的工作台', '自定义 · 运行中', true],
        ['翻译助手', 'AI 应用 · 运行中', true],
        ['报告生成器', 'Agent 应用', true],
        ['＋ 接入应用', '开放接口', false]
      ];
      items.forEach((it, i) => {
        const cx = x + (i % cols) * (cw + 10);
        const cy = y + Math.floor(i / cols) * (ch + 10);
        const on = it[2];
        ctx.fillStyle = on ? 'rgba(24,32,54,0.92)' : 'rgba(14,18,32,0.9)';
        U.roundRect(ctx, cx, cy, cw, ch, 4);
        ctx.fill();
        ctx.strokeStyle = U.rgba('#4f8dff', on ? 0.45 : 0.2);
        ctx.stroke();

        // 槽位图标
        ctx.fillStyle = U.rgba('#4f8dff', on ? 0.9 : 0.35);
        U.roundRect(ctx, cx + 10, cy + 14, 22, 22, 4);
        ctx.fill();
        ctx.font = F(12, 700);
        ctx.fillStyle = '#04060f';
        ctx.textAlign = 'center';
        ctx.fillText(it[0][0], cx + 21, cy + 30);
        ctx.textAlign = 'left';

        ctx.font = F(12, 700);
        ctx.fillStyle = 'rgba(225,238,255,0.9)';
        ctx.fillText(it[0], cx + 42, cy + 24);
        ctx.font = F(10.5, 500);
        if (on) {
          ctx.fillStyle = 'rgba(120,220,150,0.85)';
          ctx.fillText('● ' + it[1], cx + 42, cy + 44);
        } else {
          const dots = '.'.repeat(1 + Math.floor(this.tl * 2) % 3);
          ctx.fillStyle = U.rgba('#4f8dff', 0.8);
          ctx.fillText('◌ ' + it[1] + dots, cx + 42, cy + 44);
        }
      });

      ctx.font = F(11, 500);
      ctx.fillStyle = 'rgba(150,180,220,0.5)';
      ctx.fillText('自定义工作台 · 自定义 Agent / AI 应用，即插即用', x, r[1] + r[3] - 14);
    }

    /* =========================================================
        核心：对话指挥台
       ========================================================= */
    drawCore(ctx) {
      const m = CORE;
      const r = m.rect;
      const active = this.sel === m.id || !this.sel;
      this.drawScreenFrame(ctx, r, m.color, m.title, m.en, active, true);
      this.clipContent(ctx, r, () => this.drawCoreContent(ctx, r));
    }

    drawCoreContent(ctx, r) {
      const x = r[0] + 22, w = r[2] - 44;

      // ---- 布局常量：输入框在底，执行流水在输入框上方，消息锚在流水上方 ----
      const iy = r[1] + r[3] - 52;
      const steps = [
        ['① 调取资料', '知识库', 2],
        ['② 生成简报', '智能体 · 写手', 3],
        ['③ 发送 / 提醒', '自动化', 4]
      ];
      const sx0 = x + 6;
      const sy0 = iy - steps.length * 40 - 22;
      const msgBottom = sy0 - 16;
      const bubbleH = 34;

      // 副标题
      ctx.font = F(12, 500);
      ctx.fillStyle = 'rgba(140,175,215,0.55)';
      ctx.fillText('超级助手 · 小V —— 把需求变成已完成的事', x, r[1] + 48);

      // ---- 对话消息（自下而上堆叠，最新的在最下） ----
      const shown = [];
      for (let i = 0; i <= this.lineIdx && i < SCRIPT.length; i++) {
        const line = SCRIPT[i];
        const isCur = i === this.lineIdx;
        const chars = isCur
          ? Math.min(line.text.length, Math.floor(this._lineClock / 0.045))
          : line.text.length;
        if (isCur && chars <= 0) continue;
        shown.push({ line, chars, isCur });
      }

      let yb = msgBottom;
      for (let si = shown.length - 1; si >= 0; si--) {
        const s = shown[si];
        const isU = s.line.who === 'u';
        const text = s.line.text.slice(0, s.chars);
        ctx.font = F(13, 500);
        const tw2 = ctx.measureText(text).width;
        const bw = Math.min(w - 20, tw2 + 28);
        const bx = isU ? x + w - bw : x;
        const col = isU ? P.violet : P.cyan;
        const y = yb - bubbleH;

        ctx.fillStyle = isU ? 'rgba(60,40,90,0.55)' : 'rgba(10,32,44,0.72)';
        U.roundRect(ctx, bx, y, bw, bubbleH, 6);
        ctx.fill();
        ctx.strokeStyle = U.rgba(col, s.isCur ? 0.75 : 0.3);
        ctx.lineWidth = 1;
        ctx.stroke();

        ctx.fillStyle = isU ? 'rgba(225,210,255,0.95)' : 'rgba(200,240,255,0.95)';
        ctx.fillText(text, bx + 12, y + 22);

        // 当前 AI 行的打字光标
        if (s.isCur && !isU && s.chars < s.line.text.length) {
          if (Math.floor(this.tl * 3) % 2 === 0) {
            ctx.fillStyle = U.rgba(col, 0.9);
            ctx.fillRect(bx + 14 + tw2, y + 11, 6, 13);
          }
        }

        // 完成行加辉光
        if (!isU && s.line.text[0] === '✓') {
          ctx.globalCompositeOperation = 'lighter';
          U.drawGlow(ctx, P.cyan, bx + 8, y + 17, 60, 0.15, 0.3);
          ctx.globalCompositeOperation = 'source-over';
        }

        yb = y - 10;
        if (yb < r[1] + 66) break;
      }

      // ---- 执行流水：把「AI 三步执行」可视化 ----
      // 竖向进度线
      ctx.strokeStyle = 'rgba(0,234,255,0.18)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(sx0 + 8, sy0 + 14);
      ctx.lineTo(sx0 + 8, sy0 + steps.length * 40 - 18);
      ctx.stroke();

      steps.forEach((st, i) => {
        const ry = sy0 + i * 40;
        const done = this.lineIdx > st[2];
        const run = this.lineIdx === st[2];
        ctx.beginPath();
        ctx.arc(sx0 + 8, ry + 14, 6, 0, U.TAU);
        ctx.fillStyle = done ? U.rgba(P.cyan, 0.9) : run ? '#062832' : '#0b1220';
        ctx.fill();
        ctx.strokeStyle = done ? U.rgba(P.cyan, 0.9) : run ? P.cyan : 'rgba(120,150,190,0.35)';
        ctx.lineWidth = run ? 2.4 : 1.4;
        ctx.stroke();
        if (run) {
          ctx.globalCompositeOperation = 'lighter';
          U.drawGlow(ctx, P.cyan, sx0 + 8, ry + 14, 24, 0.5 + 0.25 * Math.sin(this.tl * 5), 0.3);
          ctx.globalCompositeOperation = 'source-over';
        }
        ctx.font = F(12.5, done || run ? 700 : 500);
        ctx.fillStyle = done ? 'rgba(210,245,255,0.92)' : run ? 'rgba(230,250,255,0.95)' : 'rgba(150,180,215,0.45)';
        ctx.fillText(st[0] + (done ? '  ✓' : run ? (Math.floor(this.tl * 3) % 2 ? ' ▌' : '') : ''), sx0 + 26, ry + 19);
        ctx.font = F(10.5, 600);
        ctx.textAlign = 'right';
        ctx.fillStyle = done || run ? U.rgba(P.cyan, 0.75) : 'rgba(130,160,200,0.35)';
        ctx.fillText('→ ' + st[1], x + w - 14, ry + 19);
        ctx.textAlign = 'left';
      });

      // ---- 输入框 ----
      ctx.fillStyle = 'rgba(12,18,34,0.95)';
      U.roundRect(ctx, x, iy, w, 34, 6);
      ctx.fill();
      ctx.strokeStyle = U.rgba(P.cyan, 0.35);
      ctx.stroke();
      ctx.font = F(12.5, 500);
      const ph = ['输入需求，回车发送…', '试试：帮我整理周报…', '试试：每天早上推送简报…'][
        Math.floor(this.tl / 4) % 3
      ];
      ctx.fillStyle = 'rgba(140,175,215,0.5)';
      ctx.fillText(ph, x + 14, iy + 22);

      // 发送键
      ctx.fillStyle = U.rgba(P.cyan, 0.16);
      U.roundRect(ctx, x + w - 62, iy + 6, 52, 22, 4);
      ctx.fill();
      ctx.strokeStyle = U.rgba(P.cyan, 0.6);
      ctx.stroke();
      ctx.font = F(11, 700);
      ctx.fillStyle = U.rgba(P.cyan, 0.95);
      ctx.fillText('发送', x + w - 46, iy + 21);

      // 派发时的边缘闪光
      if (this.coreFlash > 0.01) {
        ctx.globalCompositeOperation = 'lighter';
        ctx.strokeStyle = U.rgba(P.cyan, this.coreFlash * 0.5);
        ctx.lineWidth = 2;
        U.roundRect(ctx, r[0] + 6, r[1] + 6, r[2] - 12, r[3] - 12, 6);
        ctx.stroke();
        ctx.globalCompositeOperation = 'source-over';
      }
    }
  }

  CN.ConsoleScene = ConsoleScene;
})();
