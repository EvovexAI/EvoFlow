/* =========================================================
   CyberNeon · UI
   控制面板 / 空闲隐藏 / 自动巡航 / 快捷键
   ========================================================= */
(function () {
  'use strict';

  const U = CN.utils;

  const SCENE_META = [
    { id: 'outdoor', idx: '01', name: '雨夜霓虹城', sub: 'OUTDOOR · NIGHT CITY' },
    { id: 'indoor', idx: '02', name: '控制中枢', sub: 'INDOOR · CONTROL DECK' },
    { id: 'tunnel', idx: '03', name: '数据隧道', sub: 'DEPTH · DATA TUNNEL' }
  ];

  class UI {
    constructor(engine) {
      this.e = engine;
      this.root = document.getElementById('panel');
      this.hidden = false;
      this.idleTimer = 0;
      this.autoTimer = 0;
      this.visible = true;

      this._build();
      this._bindKeys();
      this._startAutoRotate();
    }

    _build() {
      // 场景列表
      const list = document.getElementById('sceneList');
      list.innerHTML = '';
      SCENE_META.forEach((m) => {
        const btn = document.createElement('button');
        btn.className = 'scene-item';
        btn.dataset.scene = m.id;
        btn.innerHTML = `
          <span class="si-idx">${m.idx}</span>
          <span class="si-txt">
            <span class="si-name">${m.name}</span>
            <span class="si-sub">${m.sub}</span>
          </span>
          <span class="si-dot"></span>`;
        btn.addEventListener('click', () => {
          this.e.setScene(m.id);
          this._pulse();
        });
        list.appendChild(btn);
      });

      // 滑块
      document.querySelectorAll('[data-bind]').forEach((el) => {
        const key = el.dataset.bind;
        const out = el.parentElement.querySelector('.slider-val');

        if (el.type === 'checkbox') {
          el.checked = !!CN.settings[key];
          el.addEventListener('change', () => {
            CN.settings[key] = el.checked;
            CN.saveSettings();
            this._pulse();
            if (key === 'autoRotate') this.autoTimer = 0;
          });
        } else {
          el.value = CN.settings[key];
          const sync = () => {
            if (out) out.textContent = Math.round(el.value * 100) + '%';
          };
          sync();
          el.addEventListener('input', () => {
            CN.settings[key] = parseFloat(el.value);
            sync();
            CN.saveSettings();
            this._pulse();
          });
        }
      });

      // 全屏
      document.getElementById('btnFull').addEventListener('click', () => {
        if (!document.fullscreenElement) {
          document.documentElement.requestFullscreen().catch(() => {});
        } else {
          document.exitFullscreen().catch(() => {});
        }
        this._pulse();
      });

      // 隐藏 UI
      document.getElementById('btnHide').addEventListener('click', () => this.toggleHide(true));

      // 播放/暂停
      const btnPause = document.getElementById('btnPause');
      const syncPause = () => {
        btnPause.classList.toggle('on', CN.settings.paused);
        btnPause.textContent = CN.settings.paused ? '▶' : '❚❚';
      };
      btnPause.addEventListener('click', () => {
        CN.settings.paused = !CN.settings.paused;
        CN.saveSettings();
        syncPause();
        this._pulse();
      });
      syncPause();

      // 场景变化 → 高亮
      window.addEventListener('cn:scene', (ev) => {
        document.querySelectorAll('.scene-item').forEach((b) => {
          b.classList.toggle('active', b.dataset.scene === ev.detail);
        });
        this._updateHud(ev.detail);
      });

      // 左下角热区：恢复隐藏的 UI
      const hot = document.getElementById('hotzone');
      hot.addEventListener('mouseenter', () => {
        if (this.hidden) this.toggleHide(false);
      });

      this._updateHud(CN.settings.scene);
    }

    _updateHud(sceneId) {
      const m = SCENE_META.find((x) => x.id === sceneId) || SCENE_META[0];
      const el = document.getElementById('hudScene');
      if (el) {
        el.innerHTML = `<span class="hud-num">${m.idx}</span>
          <span class="hud-name">${m.name}</span>
          <span class="hud-sub">${m.sub}</span>`;
      }
      document.querySelectorAll('.scene-item').forEach((b) => {
        b.classList.toggle('active', b.dataset.scene === sceneId);
      });
    }

    _pulse() {
      this.root.classList.remove('pulse');
      // 强制重排以重启动画
      void this.root.offsetWidth;
      this.root.classList.add('pulse');
    }

    toggleHide(silent) {
      this.hidden = !this.hidden;
      document.body.classList.toggle('ui-hidden', this.hidden);
      if (!silent && !this.hidden) this._pulse();
    }

    _bindKeys() {
      window.addEventListener('keydown', (e) => {
        const k = e.key.toLowerCase();
        if (k === '1') this.e.setScene('outdoor');
        else if (k === '2') this.e.setScene('indoor');
        else if (k === '3') this.e.setScene('tunnel');
        else if (k === 'h') this.toggleHide(false);
        else if (k === 'f') document.getElementById('btnFull').click();
        else if (k === ' ') {
          e.preventDefault();
          document.getElementById('btnPause').click();
        } else if (k === 'n') {
          this._nextScene();
        }
      });
    }

    _nextScene() {
      const i = SCENE_META.findIndex((m) => m.id === this.e.sceneName);
      const n = SCENE_META[(i + 1) % SCENE_META.length];
      this.e.setScene(n.id);
    }

    _startAutoRotate() {
      setInterval(() => {
        if (!CN.settings.autoRotate) return;
        if (CN.settings.paused) return;
        this.autoTimer += 1;
        // 每 45 秒换一个场景
        if (this.autoTimer >= 45) {
          this.autoTimer = 0;
          this._nextScene();
        }
      }, 1000);
    }

    tick(dt) {
      // 空闲时淡出面板
      const p = this.e.pointer;
      const moving = p.idle < 1.6;

      if (!this.hidden) {
        if (!moving && this.visible) {
          this.idleTimer += dt;
          if (this.idleTimer > 2.4) {
            this.root.classList.add('dim');
            this.visible = false;
          }
        } else if (moving && !this.visible) {
          this.root.classList.remove('dim');
          this.visible = true;
          this.idleTimer = 0;
        }
        if (moving) this.idleTimer = 0;
      }

      // HUD 帧率
      const f = document.getElementById('hudFps');
      if (f) f.textContent = Math.round(this.e.fps) + ' FPS';
    }
  }

  CN.UI = UI;
})();
