"""V4 flush-buffer coalesce — ZCode ``packages/shared/src/zcode-protocol-v4/coalesce.ts`` 的 Python 移植。

语义要求（与原文件逐条对齐）：``coalesce(deltas)`` 与逐条投递等价——两种 delivery
profile 处理同一事件序列后，终态必须逐字节一致。黄金裁判见 ZCode ``apply.ts``。

规则（封闭集合）：
  1. 相邻同 (rowId, path) 的 row.delta → append 拼接；
  2. 相邻 state.updated → patch 键浅合并（键内整体替换，安全）；
  3. row.delta 后随同 rowId 的 row.upserted → 前者丢弃（整行替换蕴含所有追加）；
  4. row.removed 是屏障，任何规则不得跨越；
  5. 帧超限切分不在本函数（由通道层打帧）；
  6. workflowRun.* 增量合并：EvoFlow 当前不产出 workflowRun delta，原样透传（不合并
     仍是语义保持的——coalesce 是可选优化，不做优化不改变终态）。
"""

from __future__ import annotations

from typing import Any


def _is_barrier(delta: dict[str, Any]) -> bool:
    return delta.get("op") == "row.removed"


def coalesce_conversation_deltas(deltas: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """对一个 flush 窗口内的 delta 序列做语义保持合并。

    输入输出均按权威日志序；纯函数，不修改入参。
    """
    result: list[dict[str, Any]] = []

    for delta in deltas:
        op = str(delta.get("op") or "")

        # 规则 3：row.upserted 吞掉同 rowId 更早的 row.delta。
        # 只回溯到最近的屏障（规则 4），且不越过同 rowId 的前一次 upserted/appended——
        # 越过会吞掉「上一代行」的追加，改变终态。
        if op == "row.upserted":
            row_id = delta.get("row", {}).get("rowId")
            i = len(result) - 1
            while i >= 0:
                prev = result[i]
                prev_op = str(prev.get("op") or "")
                if _is_barrier(prev):
                    break
                if prev_op == "row.delta" and prev.get("rowId") == row_id:
                    result.pop(i)
                    i -= 1
                    continue
                if prev_op in ("row.upserted", "row.appended") and (
                    prev.get("row", {}).get("rowId") == row_id
                ):
                    break
                i -= 1

        last = result[-1] if result else None
        last_op = str(last.get("op") or "") if last else ""

        # 规则 1：相邻同 (rowId, path) 的 row.delta 拼接。
        if (
            op == "row.delta"
            and last_op == "row.delta"
            and last is not None
            and last.get("rowId") == delta.get("rowId")
            and last.get("path") == delta.get("path")
        ):
            result[-1] = {
                "op": "row.delta",
                "rowId": delta.get("rowId"),
                "path": delta.get("path"),
                "append": str(last.get("append") or "") + str(delta.get("append") or ""),
            }
            continue

        # 规则 2：相邻 state.updated 浅合并（后者的键覆盖前者；键内整体替换所以安全）。
        if op == "state.updated" and last_op == "state.updated" and last is not None:
            merged_patch = {**(last.get("patch") or {}), **(delta.get("patch") or {})}
            result[-1] = {"op": "state.updated", "patch": merged_patch}
            continue

        # 相邻同 rowId 的 row.upserted：留最后一条（整行替换的传递性）。
        if (
            op == "row.upserted"
            and last_op == "row.upserted"
            and last is not None
            and last.get("row", {}).get("rowId") == delta.get("row", {}).get("rowId")
        ):
            result[-1] = delta
            continue

        result.append(delta)

    return result


__all__ = ["coalesce_conversation_deltas"]
