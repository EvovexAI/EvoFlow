// 一条命令：打开画图里画一颗填充红的实心爱心（约 8~12s）
//
// 这段就是 node_repl 里**一个 cell 的全文**，原样粘贴即可，不要拆成多个 cell。
// 拆开必然变慢且会踩「frame no longer maps to a live display」。
//
// 前置：画图(mspaint)已经在运行。没开先 `start mspaint`。

const root =
  process.env.ZCODE_CUA_PLUGIN_ROOT ??
  process.env.ZCODE_PLUGIN_ROOT ??
  process.env.CLAUDE_PLUGIN_ROOT;
const { join } = await import("node:path");
const { pathToFileURL } = await import("node:url");
const { setupComputerUseRuntime } = await import(
  pathToFileURL(join(root, "scripts", "computer-use-client.mjs")).href
);
await setupComputerUseRuntime({ globals: globalThis });

const flows = await import(
  pathToFileURL("D:/dev/github/EvoFlow/scripts/cua/flows.mjs").href
);

const t0 = Date.now();
const r = await flows.drawRedHeart({ cu: globalThis.agent.computerUse });
console.log(JSON.stringify(r), "wall", Date.now() - t0, "ms");

// 可选：顺手存盘成 PNG（画图里 ctrl+s 会弹另存为，不如直接截图留证）
// const shot = await globalThis.agent.computerUse.getApp({ pid: r.pid, window_id: r.windowId });
