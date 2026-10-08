/**
 * 只同步创建页自动填入的默认标题。
 *
 * 默认标题曾只在表单初始化时读取 locale，切换语言后其它文案已更新，输入框却保留旧语言。
 * 用户输入、模板草稿和已保存任务标题都是业务数据，不能因切换界面语言而被覆盖。
 */
export function resolveLocalizedAutomationCreateTitle({
  currentTitle,
  hasInitialDraft,
  isEditing,
  nextDefaultTitle,
  previousDefaultTitle,
  titleTouched,
}: {
  currentTitle: string;
  hasInitialDraft: boolean;
  isEditing: boolean;
  nextDefaultTitle: string;
  previousDefaultTitle: string;
  titleTouched: boolean;
}): string {
  if (isEditing || hasInitialDraft || titleTouched || currentTitle !== previousDefaultTitle) {
    return currentTitle;
  }
  return nextDefaultTitle;
}
