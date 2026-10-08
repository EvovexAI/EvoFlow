import { Cron } from "croner";

/** 校验 cron 表达式是否合法（5 段，本地时区）。 */
export function isValidCronExpr(cronExpr: string): boolean {
  try {
    // croner 构造时即解析，非法表达式会抛错。
    new Cron(cronExpr);
    return true;
  } catch {
    return false;
  }
}
