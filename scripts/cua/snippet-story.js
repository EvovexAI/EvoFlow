// 一条命令：用 WPS 打开一个 .docx，实时逐段把正文敲进去、存盘、回读核对字数（约 6~15s，取决于字数）
//
// 这段是 node_repl 里**一个 cell 的全文**，原样粘贴。字数越多越久，200 字约 6~8s。
//
// 关键：**不要在 WPS 首页点任何东西**（CEF 命中区不可信，会把「新建」点成「WPS 听记」）。
// 正确路径 = python-docx 造空白 docx → wps.exe 直接打开 → 点正文 → typeText。

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

// 每段一句，段落之间自动 Return 分段（用户要看到一段段实时出现，不要整篇粘贴）
const paragraphs = [
  "从前，有一只小狐狸，它最怕黑。",
  "每到夜里，它就把尾巴盘成一只小小的灯笼，假装自己能发光。",
  "有一天，月亮从云后面探出头，说：你不必假装，我给你一盏灯。",
  "小狐狸愣住了。它第一次发现，黑暗里原来一直有光，只是自己闭着眼。",
  "从那以后，它不再怕黑，因为它知道，光一直在那里。",
];

const t0 = Date.now();
const r = await flows.writeStoryToWps({
  cu: globalThis.agent.computerUse,
  file: "D:/dev/github/EvoFlow/outputs/小狐狸的月亮灯.docx",
  paragraphs,
});
console.log(JSON.stringify(r, null, 1), "wall", Date.now() - t0, "ms");
