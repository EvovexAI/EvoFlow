/**
 * 会话上下文里 Resume 回调的供给门。
 *
 * 按下 Resume 会真的起一台引擎，所以灰度未命中时不能留任何一条起引擎的路。工具卡页脚
 * （create-workflow 渲染器）与轮尾摘要卡（ConversationWorkflowDigests）都以「回调在不在场」
 * 作为按钮的门控，所以只要在会话上下文这一个供给点断掉，两处按钮一起消失——不需要把灰度
 * 逐个传进叶子组件。run 详情面板走的是自己的 sendCommand，另有一道同义的门。
 *
 * 只读会话（分享只读时间线）本来就不提供 Resume，这条规则保持不变。
 *
 * 已经存在的 run 照常渲染：卡片、摘要、run 面板与产物一件不少，只是按不动。
 */
export function resolveWorkflowResumeHandler<THandler>(options: {
  readOnly: boolean | undefined;
  /** 灰度快照未就绪时传 false：未知即不提供（fail-closed）。 */
  dynamicWorkflowEnabled: boolean;
  handler: THandler;
}): THandler | undefined {
  if (options.readOnly === true) return undefined;
  if (!options.dynamicWorkflowEnabled) return undefined;
  return options.handler;
}
