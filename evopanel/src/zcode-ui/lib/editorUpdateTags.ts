/** 程序化更新（setText、setEditorStateJson 等）的通用标记 */
export const PROGRAMMATIC_UPDATE_TAG = "zcode-programmatic";

/**
 * 历史导航回填专用标记。
 * 此前 PromptHistoryPlugin 回填历史条目时使用通用 PROGRAMMATIC_UPDATE_TAG，
 * SlashCommandPlugin 的 update listener 无法区分"用户正在输入 slash 查询"与
 * "历史导航把含 / 的旧条目写回编辑器"，导致面板重新打开并以 COMMAND_PRIORITY_CRITICAL
 * 注册方向键处理器，将后续 ArrowUp/ArrowDown 全部吞掉，历史索引无法继续翻阅。
 * 使用独立标记后，SlashCommandPlugin 可精确跳过历史回填更新，不影响用户手输 / 时的正常面板行为。
 */
export const HISTORY_NAVIGATION_UPDATE_TAG = "zcode-history-navigation";
