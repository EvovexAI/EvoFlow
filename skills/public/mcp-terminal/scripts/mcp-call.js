#!/usr/bin/env node
/**
 * mcp-call.js — 调用 MCP 服务器的指定工具
 *
 * 用法:
 *   node scripts/mcp-call.js <package> <tool> [jsonArgs] [extraArgs...]
 *
 * 示例:
 *   node scripts/mcp-call.js @lark-opendata/lark-mcp feishu_message_send '{"receive_id":"oc_xxxx","content":"hello","msg_type":"text"}'
 *   node scripts/mcp-call.js @modelcontextprotocol/server-filesystem read_file '{"path":"/tmp/test.txt"}'
 */
const { spawn } = require("child_process");

const [pkg, tool, argsJson, ...serverArgs] = process.argv.slice(2);
if (!pkg || !tool) {
  console.error("用法: node scripts/mcp-call.js <package> <tool> [jsonArgs] [extraArgs...]");
  process.exit(1);
}

let arguments = {};
if (argsJson) {
  try {
    arguments = JSON.parse(argsJson);
  } catch {
    console.error("参数必须是有效的 JSON 字符串");
    process.exit(1);
  }
}

const request = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name: tool, arguments },
});

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
