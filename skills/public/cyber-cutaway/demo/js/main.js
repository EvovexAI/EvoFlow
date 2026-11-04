/* =========================================================
   CyberJet · 入口
   ========================================================= */
(function () {
  'use strict';

  function boot() {
    const gl = document.getElementById('gl');
    const glow = document.getElementById('glow');

    const app = new CJ.CyberJet(gl, glow);
    const ui = new CJ.CyberUI(app);

    window.addEventListener('resize', () => app.resize());

    app.start();

    // 帧率回填
    setInterval(() => ui.tick(), 500);

    // 开场：镜头由远推近 + 扫描一次 + 掀开蒙皮，提示"这台机器可以拆"
    app.cam.dist = 52;
    app.cam.tDist = 52;
    app.cam.auto = false;

    setTimeout(() => {
      app.cam.tDist = 30;
      app.setScan(true);
      document.getElementById('btnScan').classList.add('on');
    }, 500);

    setTimeout(() => {
      app.setOpen(0.85);
      document.getElementById('openRange').value = 85;
      document.getElementById('openVal').textContent = '85%';
      document.getElementById('modeTag').textContent = '剖解模式 · 蒙皮开启';
    }, 2600);

    setTimeout(() => {
      app.setOpen(0);
      app.setScan(false);
      document.getElementById('btnScan').classList.remove('on');
      document.getElementById('openRange').value = 0;
      document.getElementById('openVal').textContent = '0%';
      document.getElementById('modeTag').textContent = '剖解模式 · 待机';
      app.cam.auto = true;
    }, 6400);

    CJ.app = app;
    CJ.ui = ui;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
