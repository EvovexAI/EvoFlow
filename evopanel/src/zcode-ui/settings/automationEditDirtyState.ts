export type AutomationEditDirtyField =
  | "title"
  | "prompt"
  | "schedule"
  | "mode"
  | "thoughtLevel"
  | "model";

export type AutomationEditFieldSignatures = Record<AutomationEditDirtyField, string>;

/** 只比较用户实际操作过的字段，避免把表单初始化后的系统归一化误判为修改。 */
export function resolveChangedAutomationEditFields(params: {
  touchedFields: ReadonlySet<AutomationEditDirtyField>;
  current: AutomationEditFieldSignatures;
  baseline: Partial<AutomationEditFieldSignatures>;
}): AutomationEditDirtyField[] {
  return [...params.touchedFields].filter(
    (field) =>
      params.baseline[field] !== undefined && params.current[field] !== params.baseline[field],
  );
}
