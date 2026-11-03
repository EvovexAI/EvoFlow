/* =========================================================
   CyberNeon · 入口
   ========================================================= */
(function () {
  'use strict';

  function boot() {
    CN.loadSettings();

    const canvas = document.getElementById('stage');
    const engine = new CN.Engine(canvas);

    engine.register('outdoor', CN.scenes.outdoor);
    engine.register('indoor', CN.scenes.indoor);
    engine.register('tunnel', CN.scenes.tunnel);

    engine.resize();

    const startScene = CN.scenes[CN.settings.scene] ? CN.settings.scene : 'outdoor';
    engine.setScene(startScene, true);

    const ui = new CN.UI(engine);
    engine.onFrame = (dt) => ui.tick(dt);

    engine.start();

    // 调试/扩展用
    CN.app = { engine, ui };

    // 窗口重新可见时刷新时间基准，避免切回来时一帧跳很大
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) engine.last = performance.now();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
