#!/usr/bin/env node
/**
 * mcp-list.js — 列出 MCP 服务器的可用工具
 *
 * 用法:
 *   node scripts/mcp-list.js <package> [args...]
 *
 * 示例:
 *   node scripts/mcp-list.js @lark-opendata/lark-mcp
 *   node scripts/mcp-list.js @modelcontextprotocol/server-filesystem /path/to/dir
 */
const { spawn } = require("child_process");

const [pkg, ...serverArgs] = process.argv.slice(2);
if (!pkg) {
  console.error("用法: node scripts/mcp-list.js <package> [args...]");
  process.exit(1);
}

const request = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });

const child = spawn(
  process.platform === "win32" ? "npx.cmd" : "npx",
  ["-y", pkg, ...serverArgs],
  { stdio: ["pipe", "pipe", "inherit"] }
);

let output = "";
child.stdout.on("data", (chunk) => (output += chunk.toString()));

child.on("close", (code) => {
  if (code !== 0) {
    console.error(`进程退出码: ${code}`);
    process.exit(code);
  }
  try {
    const parsed = JSON.parse(output);
    if (parsed.error) {
      console.error("MCP 错误:", JSON.stringify(parsed.error, null, 2));
      process.exit(1);
    }
    console.log(JSON.stringify(parsed.result, null, 2));
  } catch {
    console.log(output);
  }
});

child.stdin.write(request);
child.stdin.end();
