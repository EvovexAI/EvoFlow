/* =========================================================
   EvoFlow 启动层嵌入：中枢指挥台
   在 #boot-splash 的深色面板里运行 2D 控制台（自动巡游讲解），
   首帧不等它；启动页淡出移除时自动停机。
   依赖（defer 按序加载）：utils.js → engine.js → scene.js → ui.js
   ========================================================= */
(function () {
  'use strict';

  let started = false;

  function boot() {
    if (started) return;
    started = true;

    const host = document.getElementById('bc-host');
    if (!host || !window.CN || !CN.Engine) return;
    // 启动页已被移除（极快加载）→ 不启动
    if (!host.isConnected) return;

    const canvas = document.createElement('canvas');
    host.appendChild(canvas);

    // HUD：标签 + 字幕（id=hud 与引擎的点击豁免名单对齐）
    const hud = document.createElement('div');
    hud.id = 'hud';
    hud.innerHTML =
      '<div class="bc-tabs"></div>' +
      '<div class="bc-caption"><span class="bc-prompt">&gt;</span>' +
      '<span class="bc-text"></span></div>';
    host.appendChild(hud);

    const engine = new CN.Engine(canvas);
    CN.loadSettings();
    engine.register('console', (eng) => new CN.ConsoleScene(eng));

    // 嵌入模式：尺寸跟随宿主面板
    const fit = () => {
      const w = host.clientWidth, h = host.clientHeight;
      if (w > 60 && h > 60) engine.resize(w, h);
    };
    fit();
    if (window.ResizeObserver) new ResizeObserver(fit).observe(host);
    else window.addEventListener('resize', fit);

    engine.setScene('console', true);
    engine.start();
    window.CJ = { app: engine };

    CN.ui.init(engine, {
      tabs: hud.querySelector('.bc-tabs'),
      caption: hud.querySelector('.bc-text')
    });

    // 启动页淡出移除时同步停机（router.js removeBootSplash 派发）
    window.addEventListener('ef:console-stop', () => {
      try { CN.ui.destroy(); } catch (_) {}
      engine.stop();
    }, { once: true });
  }

  // 首帧优先：不抢启动进度的第一帧，load 后再起画布
  if (document.readyState === 'complete') {
    setTimeout(boot, 250);
  } else {
    window.addEventListener('load', () => setTimeout(boot, 250), { once: true });
  }
})();
