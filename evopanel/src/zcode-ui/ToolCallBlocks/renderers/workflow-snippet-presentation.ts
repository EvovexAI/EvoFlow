import type { ToolCallEvalWorkflowSnippetDisplay } from "@zcode/shared/zcode-protocol-v4";

/** handler 的 response 面向模型，含重复耗时/日志；只解包已知格式，未知/截断内容保留。 */
export function snippetResponse(display: ToolCallEvalWorkflowSnippetDisplay): string | undefined {
  let text = display.response;
  const logs = display.logs.length
    ? `\n\nLogs:\n${display.logs.map((line) => `- ${line}`).join("\n")}`
    : undefined;
  if (
    logs &&
    (text.startsWith(`The snippet completed in ${display.durationMs}ms.\n`) ||
      text.startsWith("The snippet failed ("))
  ) {
    for (const suffix of [logs, `${logs}\n- … (logs truncated)`]) {
      if (text.endsWith(suffix)) {
        text = text.slice(0, -suffix.length);
        break;
      }
    }
  }
  if (display.ok) {
    const prefix = `The snippet completed in ${display.durationMs}ms.\n`;
    if (text.startsWith(prefix)) {
      text = text.slice(prefix.length);
      if (text === "It returned no value.") return undefined;
      if (text.startsWith("Return value:\n")) text = text.slice("Return value:\n".length);
    }
  } else if (display.diagnostics.length) {
    const diagnostics = display.diagnostics
      .map((d) => `L${d.line}:C${d.column} ${d.message}`)
      .join("\n");
    if (
      text ===
      `The snippet has errors:\n${diagnostics}\n\nNOTE: The snippet was NOT executed — fix the errors above and call the tool again.`
    )
      return undefined;
  }
  return text.trim() ? text : undefined;
}

export function snippetValue(value: string): { code: string; language: string } {
  try {
    return { code: JSON.stringify(JSON.parse(value), null, 2), language: "json" };
  } catch {
    return { code: value, language: "text" };
  }
}
