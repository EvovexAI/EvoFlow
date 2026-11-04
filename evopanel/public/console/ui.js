/* =========================================================
   EvoFlow Console · UI
   底部字幕条 / 模块标签 / 自动巡游
   ========================================================= */
(function () {
  'use strict';

  const U = CN.utils;
  const CAPTIONS = {
    core: '「对话指挥台」你说一句话，AI 负责拆解、派发、汇报——不用挨个打开工具。',
    tasks: '「任务中心」所有事项一块看板：待办 / 进行中 / 已完成，进度实时可查。',
    flow: '「工作流」把重复工作画成流程图，一次搭建，之后每次自动运行。',
    agents: '「智能体员工」写手、分析师、助理各司其职，像同事一样接活干活。',
    knowledge: '「知识库」团队资料统一沉淀，AI 的回答有据可查。',
    auto: '「自动化」定时任务自动触发，你不盯屏幕，事情也在推进。',
    plugins: '「扩展应用」接入自定义工作台、自定义 Agent 与 AI 应用，能力持续生长。'
  };
  const TAGLINE = 'EvoFlow —— 一个对话框指挥所有系统：你说需求，AI 拆解任务、派发模块、汇总结果。';

  const TOUR = ['core', 'tasks', 'flow', 'agents', 'knowledge', 'auto', 'plugins'];

  CN.ui = {
    // opts 可传 { tabs, caption } 元素（嵌入模式）；缺省取页面 id
    init(engine, opts) {
      opts = opts || {};
      this.eng = engine;
      this.scene = engine.scene;
      this.sel = null;
      this.tourIdx = -1;
      this.tourTimer = null;
      this._keyHandler = null;

      this.caption = opts.caption || document.getElementById('caption');
      this.tabsEl = opts.tabs || document.getElementById('tabs');

      // 生成标签
      const order = TOUR;
      const mk = (id, label, color) => {
        const b = document.createElement('button');
        b.className = 'tab';
        b.dataset.id = id;
        b.innerHTML = '<i style="background:' + color + '"></i>' + label;
        b.addEventListener('click', () => this.select(id, true));
        this.tabsEl.appendChild(b);
      };
      mk('core', '对话指挥台', '#00eaff');
      order.slice(1).forEach((id) => {
        const m = this.scene.mods.find((x) => x.id === id);
        mk(id, m.title, m.color);
      });
      const ov = document.createElement('button');
      ov.className = 'tab tab-overview';
      ov.innerHTML = '<i style="background:#8fa8c8"></i>总览';
      ov.addEventListener('click', () => this.select(null, true));
      this.tabsEl.appendChild(ov);

      // 场景内点击选择
      this._selHandler = (e) => {
        this.select(e.detail.id, true);
      };
      window.addEventListener('ef:select', this._selHandler);

      // 键盘 1-7 / 0
      this._keyHandler = (e) => {
        if (e.key >= '1' && e.key <= '7') this.select(TOUR[+e.key - 1], true);
        else if (e.key === '0') this.select(null, true);
      };
      window.addEventListener('keydown', this._keyHandler);

      this.select(null, false);
      // 开场自动巡游
      setTimeout(() => this.startTour(), 1400);
    },

    /* 销毁：嵌入层随启动页移除时调用，避免残留全局监听 */
    destroy() {
      this.stopTour();
      if (this._capTimer) { clearInterval(this._capTimer); this._capTimer = null; }
      if (this._selHandler) window.removeEventListener('ef:select', this._selHandler);
      if (this._keyHandler) window.removeEventListener('keydown', this._keyHandler);
      this._selHandler = this._keyHandler = null;
    },

    startTour() {
      this.stopTour();
      this.tourIdx = -1;
      this._touring = true;
      const step = () => {
        if (!this._touring) return;
        this.tourIdx++;
        if (this.tourIdx >= TOUR.length) {
          this._touring = false;
          this.select(null, false);
          return;
        }
        this.select(TOUR[this.tourIdx], false);
        this.tourTimer = setTimeout(step, 5200);
      };
      step();
    },

    stopTour() {
      this._touring = false;
      if (this.tourTimer) { clearTimeout(this.tourTimer); this.tourTimer = null; }
    },

    typeCaption(text) {
      if (this._capTimer) { clearInterval(this._capTimer); this._capTimer = null; }
      let i = 0;
      this.caption.textContent = '';
      this.caption.classList.add('typing');
      this._capTimer = setInterval(() => {
        i++;
        this.caption.textContent = text.slice(0, i);
        if (i >= text.length) {
          clearInterval(this._capTimer);
          this._capTimer = null;
          this.caption.classList.remove('typing');
        }
      }, 22);
    },

    select(id, user) {
      if (user) this.stopTour();
      this.sel = id;
      this.scene.focus(id);

      // 标签高亮
      for (const b of this.tabsEl.children) {
        b.classList.toggle('on', b.dataset.id === (id || ''));
      }

      // 字幕
      if (id) this.typeCaption(CAPTIONS[id]);
      else this.typeCaption(TAGLINE);
    }
  };
})();
