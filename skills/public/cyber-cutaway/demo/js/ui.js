/* =========================================================
   CyberJet · UI
   ========================================================= */
(function () {
  'use strict';

  const CJ = window.CJ;
  const $ = (id) => document.getElementById(id);

  function CyberUI(app) {
    this.app = app;
    this.current = null;
    this.tourOn = false;
    this.tourIdx = 0;
    this.tourTimer = null;
    this.typeTimer = null;
    this._buildList();
    this._bind();
  }

  CyberUI.prototype._buildList = function () {
    const wrap = $('partList');
    const frag = document.createDocumentFragment();

    CJ.PARTS.forEach((p, i) => {
      const el = document.createElement('div');
      el.className = 'part';
      el.dataset.id = p.id;
      el.innerHTML =
        '<span class="idx">' + String(i + 1).padStart(2, '0') + '</span>' +
        '<div><div class="nm">' + p.name + '</div>' +
        '<div class="en">' + p.en + '</div></div>';
      el.addEventListener('click', () => {
        this.stopTour();
        this.select(p.id);
      });
      frag.appendChild(el);
    });

    wrap.appendChild(frag);
    $('partCount').textContent = String(CJ.PARTS.length).padStart(2, '0');
  };

  CyberUI.prototype._bind = function () {
    const range = $('openRange');
    range.addEventListener('input', () => {
      const v = +range.value;
      $('openVal').textContent = v + '%';
      this.app.setOpen(v / 100);
      $('modeTag').textContent = v > 4 ? '剖解模式 · 蒙皮开启' : '剖解模式 · 待机';
    });

    $('btnXray').addEventListener('click', (e) => {
      const on = e.currentTarget.classList.toggle('on');
      this.app.setXray(on);
      if (on) { this.app.setOpen(1); range.value = 100; $('openVal').textContent = '100%'; }
    });

    $('btnScan').addEventListener('click', (e) => {
      const on = e.currentTarget.classList.toggle('on');
      this.app.setScan(on);
    });

    $('btnTour').addEventListener('click', (e) => {
      const on = e.currentTarget.classList.toggle('on');
      on ? this.startTour() : this.stopTour();
    });

    document.querySelectorAll('.views button').forEach((b) => {
      b.addEventListener('click', () => {
        const v = b.dataset.view;
        if (v === 'reset') {
          this.app.reset();
          $('openRange').value = 0;
          $('openVal').textContent = '0%';
          $('btnXray').classList.remove('on');
          $('btnTour').classList.remove('on');
          this.stopTour();
          this.select(null);
        } else {
          this.app.view(v);
        }
      });
    });

    window.addEventListener('keydown', (e) => {
      const k = e.key;
      const N = CJ.PARTS.length;
      if (k >= '1' && k <= '9') {
        const p = CJ.PARTS[+k - 1];
        if (p) { this.stopTour(); this.select(p.id); }
      } else if (k === '0') {
        const p = CJ.PARTS[9];
        if (p) { this.stopTour(); this.select(p.id); }
      } else if (k === 'ArrowRight' || k === 'ArrowDown') {
        e.preventDefault();
        const i = this.current ? CJ.PARTS.findIndex((p) => p.id === this.current) : -1;
        this.stopTour();
        this.select(CJ.PARTS[(i + 1 + N) % N].id);
      } else if (k === 'ArrowLeft' || k === 'ArrowUp') {
        e.preventDefault();
        const i = this.current ? CJ.PARTS.findIndex((p) => p.id === this.current) : 0;
        this.stopTour();
        this.select(CJ.PARTS[(i - 1 + N) % N].id);
      } else if (k === ' ') {
        e.preventDefault();
        const btn = $('btnTour');
        const on = btn.classList.toggle('on');
        on ? this.startTour() : this.stopTour();
      }
    });
  };

  CyberUI.prototype.select = function (id) {
    this.current = id;
    document.querySelectorAll('.part').forEach((el) => {
      el.classList.toggle('on', el.dataset.id === id);
    });
    this.app.select(id);

    const part = CJ.PARTS.find((p) => p.id === id);
    const info = $('info');

    if (!part) {
      info.classList.add('idle');
      $('infoCode').textContent = 'EV07-00';
      $('infoEn').textContent = 'NO SELECTION';
      $('infoName').textContent = '选择左侧部件';
      $('infoSpecs').innerHTML = '';
      this._type(
        '整套结构扫描已完成。拖动旋转机体，滚轮推拉视角，或从左侧索引中选择一个部件，查看它的剖面构成与参数。'
      );
      const i = CJ.PARTS.findIndex((p) => p.id === id);
      $('infoIdx').textContent = '-- / --';
      return;
    }

    info.classList.remove('idle');
    $('infoCode').textContent = part.code;
    $('infoEn').textContent = part.en;
    $('infoName').textContent = part.name;

    const specs = $('infoSpecs');
    specs.innerHTML = part.specs.map((s) =>
      '<div class="spec">' +
      '<span class="k">' + s.k + '</span>' +
      '<span class="v">' + s.v + '</span>' +
      '<div class="bar"><span data-w="' + (s.bar * 100) + '"></span></div>' +
      '</div>'
    ).join('');

    requestAnimationFrame(() => {
      specs.querySelectorAll('.bar span').forEach((el) => {
        el.style.width = el.dataset.w + '%';
      });
    });

    const idx = CJ.PARTS.findIndex((p) => p.id === id);
    $('infoIdx').textContent =
      String(idx + 1).padStart(2, '0') + ' / ' + String(CJ.PARTS.length).padStart(2, '0');

    this._type(part.desc);
  };

  // 打字机
  CyberUI.prototype._type = function (text) {
    const el = $('infoDesc');
    clearInterval(this.typeTimer);
    el.textContent = '';
    let i = 0;
    this.typeTimer = setInterval(() => {
      i += 2;
      el.textContent = text.slice(0, i);
      if (i >= text.length) clearInterval(this.typeTimer);
    }, 16);
  };

  CyberUI.prototype.startTour = function () {
    if (this.tourOn) return;
    this.tourOn = true;
    $('btnTour').classList.add('on');
    this.app.setOpen(1);
    $('openRange').value = 100;
    $('openVal').textContent = '100%';
    $('modeTag').textContent = '剖解模式 · 自动讲解';

    this.tourIdx = this.current
      ? (CJ.PARTS.findIndex((p) => p.id === this.current) + 1) % CJ.PARTS.length
      : 0;

    const step = () => {
      this.select(CJ.PARTS[this.tourIdx % CJ.PARTS.length].id);
      this.tourIdx++;
      this.tourTimer = setTimeout(step, 6200);
    };
    step();
  };

  CyberUI.prototype.stopTour = function () {
    if (!this.tourOn) return;
    this.tourOn = false;
    clearTimeout(this.tourTimer);
    $('btnTour').classList.remove('on');
    $('modeTag').textContent = '剖解模式 · 待机';
  };

  CyberUI.prototype.tick = function () {
    const f = this.app.fps;
    const el = $('fps');
    if (el) el.textContent = Math.round(f);
  };

  CJ.CyberUI = CyberUI;
})();
