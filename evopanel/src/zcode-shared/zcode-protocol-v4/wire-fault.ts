// V4 physical assembly fault 的分类：**内容确定性失败** vs 瞬态失败。
//
// 恢复阶梯默认把 fault 当瞬态处理：先 same-sub resync（服务端可能回 resume），再断档则升级
// forceSnapshot，仍不成则 fail closed。这套升级对丢片、超时、校验和不符是对的——重投一次很可能
// 就好了。对 **schema 拒收** 却是错的：字节已经过了 length/checksum/UTF-8/JSON 四道关，被拒说明
// 本端读不懂对端发来的**内容**，而 resume 档只会把同一批 delta 再投一遍，必然同样被拒。
//
// 工具卡载荷出现不兼容字段时，重投相同内容无法恢复；应尝试快照后明确报告内容不兼容。
//
// 本模块只回答「这个 reason code 是不是确定性内容失败」，不决定怎么处置——处置在两个 store 里
// （conversationProjectionStore / sessionsIndexStore）。

/**
 * 帧内容通过了 checksum/JSON，却没过 zod schema 的 reason code。
 *
 * 常量化而不是各处写字面量：判定这一侧与产出这一侧（wire-assembler、wire-reassembly）必须永远
 * 是同一个词——两处分叉的症状正是本模块要修的那类静默失配。
 */
export const WIRE_FAULT_INVALID_PAYLOAD = "proto.frameAssemblyInvalidPayload";

/**
 * 这个 fault 是不是「同一份内容再投一次必然再被拒」的确定性失败。
 *
 * 目前只有 schema 拒收一个。刻意**不**把 `proto.frameAssemblyInvalidJson` 也算进来：JSON 不合法
 * 也可能来自组装路径本身（分片拼接、编码边界），重投确实可能不同；把瞬态误判成确定性会让本该
 * 自愈的 gap 停在原地，那是比多一次无用重试更坏的失败。按证据逐个加，不按猜测扩大。
 */
export function isDeterministicContentFault(reasonCode: string | undefined): boolean {
  return reasonCode === WIRE_FAULT_INVALID_PAYLOAD;
}

/**
 * 内容确定性失败走到底的客户端终态 code（`fault.subscription.*` 是 04-sync 的词表）。
 *
 * 与 `fault.subscription.recoveryFailed` 分开是有用的区分，不是命名洁癖：后者是「链路没恢复
 * 过来」，重连有意义；本 code 是「本端读不懂对端发来的内容」，重连必然得到同样结果。遥测按
 * code 聚合，两者混在一起会把一次版本失配读成一片网络抖动。
 */
export const SUBSCRIPTION_CONTENT_REJECTED = "fault.subscription.contentRejected";
