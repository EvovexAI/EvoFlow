export type AutomationEditRequiredField = "title" | "schedule" | "prompt";

export function resolveAutomationEditRequiredFieldErrors(params: {
  title: string;
  cronExpr: string;
  prompt: string;
}): AutomationEditRequiredField[] {
  const errors: AutomationEditRequiredField[] = [];
  if (!params.title.trim()) errors.push("title");
  if (!params.cronExpr.trim()) errors.push("schedule");
  if (!params.prompt.trim()) errors.push("prompt");
  return errors;
}

/** 正常编辑只撤销当前字段已有的提交告警，不主动产生新的告警。 */
export function clearAutomationEditRequiredFieldError(
  errors: ReadonlySet<AutomationEditRequiredField>,
  field: AutomationEditRequiredField,
): ReadonlySet<AutomationEditRequiredField> {
  if (!errors.has(field)) return errors;
  const next = new Set(errors);
  next.delete(field);
  return next;
}
