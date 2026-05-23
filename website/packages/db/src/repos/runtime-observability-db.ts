import { withDatabase } from "../client";

export async function getRuntimeObservabilitySnapshotDatabase() {
  return withDatabase(async (client) => {
    const [llmRuns, toolCalls, uiActions, sessions, jobRuns] = await Promise.all([
      client`SELECT COUNT(*)::int AS total FROM observability_llm_runs`,
      client`SELECT COUNT(*)::int AS total FROM observability_tool_calls`,
      client`SELECT COUNT(*)::int AS total FROM observability_ui_actions`,
      client`SELECT COUNT(*)::int AS total FROM observability_visitor_sessions`,
      client`SELECT COUNT(*)::int AS total FROM observability_job_runs`,
    ]);
    const recentToolRows = await client<{ tool_name: string }[]>`
      SELECT tool_name
      FROM observability_tool_calls
      ORDER BY created_at DESC
      LIMIT 24
    `;
    const latestToolNames = recentToolRows
      .map((row) => row.tool_name)
      .filter((toolName, index, array) => array.indexOf(toolName) === index)
      .slice(0, 4);

    return {
      counts: {
        jobRuns: Number(jobRuns[0]?.total ?? 0),
        llmRuns: Number(llmRuns[0]?.total ?? 0),
        sessions: Number(sessions[0]?.total ?? 0),
        toolCalls: Number(toolCalls[0]?.total ?? 0),
        uiActions: Number(uiActions[0]?.total ?? 0),
      },
      latestToolNames,
    };
  });
}
