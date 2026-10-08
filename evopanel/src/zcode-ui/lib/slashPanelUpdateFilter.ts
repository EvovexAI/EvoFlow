import { HISTORY_NAVIGATION_UPDATE_TAG } from "./editorUpdateTags.js";

/**
 * 判断 SlashCommandPlugin 的 update listener 是否应处理本次编辑器更新。
 *
 * 历史导航回填时返回 false，防止面板以 COMMAND_PRIORITY_CRITICAL 注册方向键处理器
 * 并吞掉后续的历史翻阅按键。其余更新（用户输入、其他程序化更新）均返回 true。
 */
export function shouldSlashPanelProcessUpdate(tags: ReadonlySet<string>): boolean {
  return !tags.has(HISTORY_NAVIGATION_UPDATE_TAG);
}
