const { chromium } = require('D:/dev/github/EvoFlow/node_modules/playwright-core');
const EXE = 'C:/Users/admin/AppData/Local/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-win64/chrome-headless-shell.exe';
(async () => {
  const b = await chromium.launch({ executablePath: EXE, args: ['--enable-unsafe-swiftshader'] });
  const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
  const errs = [];
  p.on('pageerror', (e) => errs.push('E:' + e.message));
  p.on('console', (m) => { if (m.type() === 'error') errs.push('C:' + m.text()); });
  await p.goto('file:///D:/dev/github/EvoFlow/evopanel/public/console/test-embed.html');
  await p.waitForTimeout(6000);
  const diag = await p.evaluate(() => ({
    fps: Math.round((window.CJ && CJ.app) ? CJ.app.fps : -1),
    sel: (window.CJ && CJ.app && CJ.app.scene) ? CJ.app.scene.sel : null,
    canvasInHost: !!document.querySelector('#bc-host canvas')
  }));
  console.log('DIAG', JSON.stringify(diag));
  await p.screenshot({ path: 'shots-embed-overview.png' });
  // 模拟启动页移除 → 停机
  await p.evaluate(() => window.dispatchEvent(new CustomEvent('ef:console-stop')));
  await p.waitForTimeout(600);
  const stopped = await p.evaluate(() => CJ.app._raf === null);
  console.log('stopped after event:', stopped);
  // 点击面板内的"任务中心"屏幕区域（画布局部坐标换算验证）
  await p.evaluate(() => { CJ.app.start && CJ.app.start(); });
  await p.waitForTimeout(1500);
  const box = await p.evaluate(() => {
    const r = document.querySelector('#bc-host canvas').getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  });
  // 任务中心 rect [42,118,402,222] 世界坐标 → 屏幕坐标需要 S/cam；直接用 scene API 验证 hitTest
  const hit = await p.evaluate(() => {
    const sc = CJ.app.scene;
    // 用 hitTest 反推：构造屏幕点 = 世界点经当前相机变换
    const k = sc.S * sc.cam.z;
    const wx = 240, wy = 230; // 任务中心中心附近
    const sx = sc.W / 2 + (wx - sc.cam.x) * k;
    const sy = sc.H / 2 + (wy - sc.cam.y) * k;
    return { sx: Math.round(sx), sy: Math.round(sy), hit: sc.hitTest(sx, sy) };
  });
  console.log('HIT', JSON.stringify(hit));
  console.log('errors:', errs.length ? errs.slice(0, 6) : 'none');
  await b.close();
})();
