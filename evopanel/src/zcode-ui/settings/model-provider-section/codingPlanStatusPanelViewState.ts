import type { CodingPlanStatus } from "./constants.js";

export interface CodingPlanStatusPanelViewState {
  displayStatus: CodingPlanStatus;
  actionStatus: CodingPlanStatus;
  balanceStatus: CodingPlanStatus;
  loginLoading: boolean;
}

export function resolveCodingPlanStatusPanelViewState({
  status,
  loginPending,
}: {
  status: CodingPlanStatus;
  loginPending: boolean;
}): CodingPlanStatusPanelViewState {
  if (!loginPending) {
    return buildStableCodingPlanStatusPanelViewState(status, false);
  }

  if (status === "purchased" || status === "notPurchased") {
    // 这两个状态都来自已解析的 entitlement snapshot。后台刷新时继续展示
    // 缓存结果并只保留 loading 标识，避免详情在旧数据与 checking 之间闪烁。
    return buildStableCodingPlanStatusPanelViewState(status, true);
  }

  return {
    // 登录 pending 和权益查询 checking 是两个语义。
    // 登录中状态文案需要反馈 checking，但按钮仍要按点击前状态保留并显示 spinner；
    // Start Plan 余额卡也不能因为登录 pending 提前出现。
    displayStatus: "checking",
    actionStatus: status,
    balanceStatus: status,
    loginLoading: true,
  };
}

function buildStableCodingPlanStatusPanelViewState(
  status: CodingPlanStatus,
  loginLoading: boolean,
): CodingPlanStatusPanelViewState {
  return {
    displayStatus: status,
    actionStatus: status,
    balanceStatus: status,
    loginLoading,
  };
}
