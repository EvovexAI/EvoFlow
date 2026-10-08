// 动态工作流（dynamic workflow）相关的测试 id。
// test-ids.ts 已顶到 oxlint max-lines 上限（400 行），工作流这一族整段拆出；
// 仍从 @zcode/shared 桶文件导出，消费方 import 路径不变。

// 已保存工作流的 GUI 中枢。
export const TID_AUTOMATIONS_PAGE_TAB = "automations-page-tab";
export const TID_WORKFLOWS_LIST = "workflows-list";
export const TID_WORKFLOWS_EMPTY = "workflows-empty";
export const TID_WORKFLOWS_REFRESH = "workflows-refresh";
export const TID_WORKFLOWS_CREATE_VIA_CHAT = "workflows-create-via-chat";
export const TID_WORKFLOW_PROJECT_GROUP = "workflow-project-group";
export const TID_WORKFLOW_GLOBAL_GROUP = "workflow-global-group";
export const TID_WORKFLOW_CARD = "workflow-card";
export const TID_WORKFLOW_CARD_RUN = "workflow-card-run";
export const TID_WORKFLOW_CARD_MENU = "workflow-card-menu";
export const TID_WORKFLOW_ACTION_DELETE = "workflow-action-delete";
export const TID_WORKFLOW_LAUNCH_DIALOG = "workflow-launch-dialog";
export const TID_WORKFLOW_LAUNCH_ARG = "workflow-launch-arg";
export const TID_WORKFLOW_LAUNCH_TARGET = "workflow-launch-target";
export const TID_WORKFLOW_LAUNCH_SUBMIT = "workflow-launch-submit";
// 直接启动：实参窗行内错误区。会话顶部长出的是普通的轮尾 run 卡。
export const TID_WORKFLOW_LAUNCH_ERROR = "workflow-launch-error";
// 轮尾 run 卡；后缀 = `${turnKey}-${toolCallId}`。
export const TID_CHAT_WORKFLOW_RUN_DIGEST = "workflow-run-digest";
export const TID_WORKFLOW_ACTION_MOVE = "workflow-action-move";
export const TID_WORKFLOW_MOVE_DIALOG = "workflow-move-dialog";
export const TID_WORKFLOW_MOVE_DIALOG_TARGET = "workflow-move-dialog-target";
export const TID_WORKFLOW_MOVE_DIALOG_SUBMIT = "workflow-move-dialog-submit";
export const TID_WORKFLOW_DETAIL = "workflow-detail";
export const TID_WORKFLOW_DETAIL_RUN = "workflow-detail-run";
export const TID_WORKFLOW_DETAIL_MENU = "workflow-detail-menu";
export const TID_WORKFLOW_DETAIL_TAB = "workflow-detail-tab";
export const TID_WORKFLOW_DETAIL_DESCRIPTION = "workflow-detail-description";
export const TID_WORKFLOW_DETAIL_WHEN_TO_USE = "workflow-detail-when-to-use";
export const TID_WORKFLOW_DETAIL_SCRIPT = "workflow-detail-script";
export const TID_WORKFLOW_META_SAVE = "workflow-meta-save";
export const TID_WORKFLOW_META_DISCARD = "workflow-meta-discard";
export const TID_WORKFLOW_RUN_ROW = "workflow-run-row";

// 用户面产物的四个表面。
//
// ⚠ 术语：这里的 artifact 是脚本经 `artifact.*` **发布给用户看**的产出（文件 / markdown /
// 看板），不是引擎内部 `RunSettlement.artifact` 那个「脚本顶层返回值」的同名词。
//
// 只有**入口级**的四样进这里（区、卡、tab 根、chip）：它们是桌面 e2e 的落脚点，两处各写一遍
// 字面量迟早漂移。区内部的版本步进器、正文各 kind、头部动作仍是组件内的字面量，与 run 详情页
// 其余分区（`workflow-run-questions` 等）保持同一习惯。
export const TID_WORKFLOW_ARTIFACTS_SECTION = "workflow-run-artifacts";
export const TID_WORKFLOW_ARTIFACTS_TOGGLE = "workflow-run-artifacts-toggle";
export const TID_WORKFLOW_ARTIFACT_CARD = "workflow-run-artifact-card";
/** `workflow-artifact` 侧板 tab 的根节点。 */
export const TID_WORKFLOW_ARTIFACT_PANE = "workflow-artifact-pane";
/** 中枢（运行历史行 / 详情页「最近产物」）上的 chip。 */
export const TID_WORKFLOW_ARTIFACT_CHIP = "workflow-run-artifact-chip";
/** 会话里终态通知行折叠头部上的 chip——与中枢那枚**刻意不同 id**：两处的载荷来源不同，
 *  e2e 要能分别指到「通知行上出现了 chips」和「中枢历史行上出现了 chips」。 */
export const TID_CHAT_WORKFLOW_ARTIFACT_CHIP = "workflow-notification-artifact-chip";
