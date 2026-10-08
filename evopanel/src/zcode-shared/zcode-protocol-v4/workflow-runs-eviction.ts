// ============================================================
// 表满时腾位：谁可以让位、什么时候入座、以及被腾掉的东西怎么继续可数
// ============================================================
// 淘汰规则是纯函数，不读取时钟或执行 I/O。表外条目的分阶段计数由 workflow-runs-unlisted.ts 维护。
//
// 为什么要腾位。触界的老语义是**拒新**，而读面画的是「此刻哪些子代理在跑」——于是一个宽
// fan-out 的 run 跑过 1024 之后，新起的子代理一个都进不来，run 卡与站点花名册永远停在最早
// 那批**已经结束**的身上，恰好把这个特性存在的理由抹掉。腾位把它反过来：终态的条目让位。
//
// 只淘汰终态条目还不够：一个阶段可能
// 在头几秒里把**全部** actor-created 与**全部** node-queued 发完，头 1024 条还排着队就把两张表
// 塞满，一条终态都没有，于是后面 976 个连人带活全被拒；调度器随后按 FIFO 派活，从第 1025 个
// 开始每一个**正在跑**的子代理都不在表上。一个子代理变重要是在它**被派活**的那一刻，不是在
// 它入队的那一刻——所以 `node-dispatched` 也是一次入座机会（下面的 activation）。
//
// 表内优先级从高到低，按这个子代理**此刻**在做什么：**在跑**（有节点处于 dispatched /
// executing / waiting / repairing / nudged）> **空闲**（一条在跑的都没有、还有排着队的：它在
// 等槽位）> **已完成**（全部已结算）。三条不变量约束了谁可以让位，每一条都对应一个看得见的后果：
//   1. 在跑的条目绝不让位——正在跑的那些正是要留住的东西；
//   2. 一个 actor 绝不比它最后一个**已列**节点活得久：actor 三态由它名下的节点派生
//      （workflow-runs-actor-status.ts），没有节点的 actor 会派生成 waiting，在读面上是一枚
//      永远不会动的 pending 徽章。所以走的时候是整组走（actor + 它全部节点），而带不进自己
//      那条节点的已完成 actor 干脆不上表（孤儿规则）；
//   3. 让位的条目**仍然可数**：run 级两个计数器（workflow-runs-caps.ts）之外，再按**出生阶段**
//      记一格（workflow-runs-unlisted.ts）——读面是按站画的。

import {
  WORKFLOW_RUNS_LIMITS,
  type WorkflowRunActor,
  type WorkflowRunNode,
  type WorkflowRunState,
} from "./workflow-runs.js";
import { addToUnlistedBucket, withUnlistedBuckets } from "./workflow-runs-unlisted.js";

/**
 * 归约使用的三项条目容量上限，默认使用 {@link WORKFLOW_RUNS_LIMITS}。
 * 淘汰与计数规则适用于调用方传入的上限。
 */
export interface WorkflowRunEntryLimits {
  readonly maxActors: number;
  readonly maxNodes: number;
  readonly maxPhases: number;
}

interface InstanceRef {
  siteId: string;
  ordinal: number;
}

/** 一个候选受害者：类内排序要用的两个键 + 它在表里的下标。 */
interface Candidate {
  index: number;
  phaseName: string | undefined;
  failed: boolean;
}

/** 一个**非 live 组**：一个 actor 加上它名下的全部已列节点（下标），以及它属于哪一类。 */
interface Group extends Candidate {
  nodeIndexes: number[];
  /** 名下节点全部已结算：这个子代理的活干完了。 */
  finished: boolean;
  /** 一条在跑的都没有、却还有排着队的：这个子代理在等槽位，它的活还没开始。 */
  idle: boolean;
  /** 名下一条已列节点都没有：还没被问过，或者它的结算是不带 actor 的缓存命中。 */
  zeroNode: boolean;
}

/** 一个离场的子代理在它那一格上的增量（`phaseName` 是它的**出生**阶段）。 */
interface EvictedAgent {
  phaseName: string | undefined;
  actors: number;
  actorsSettled?: number;
  actorsFailed?: number;
}

/** 一条节点事件的入座结果。 */
export interface WorkflowNodeSeating {
  /** 腾过位（可能已淘汰若干条目）、并且 actor 已就位的 run。 */
  run: WorkflowRunState;
  /** 这条实例可以进节点表吗（false = 照旧拒新，调用方按被拒计数）。 */
  admitNew: boolean;
  /** 这一次把一条**表外**实例放回了节点表（调用方据此把 nodesUnlisted 减 1）。 */
  activated: boolean;
}

function sameInstance(left: InstanceRef, right: InstanceRef): boolean {
  return left.siteId === right.siteId && left.ordinal === right.ordinal;
}

function isFailed(node: WorkflowRunNode): boolean {
  return node.outcome === "failed" || node.outcome === "cancelled";
}

/**
 * 这条事件可以往表里放一个**新键**吗——以及同理，可以给 `nodesUsed` 加一步吗。
 *
 * **只有溢出过的 run（`truncated`）才收紧**，`live` 传的是那条收紧后的条件（抬过水位的出生
 * 事件，或下面的 activation）。界之下一律放行，与腾位改造之前逐字相同。
 *
 * 为什么收紧：腾位是第一件让表**变短**的事，于是一个空出来的位子可能把一条早已计进
 * `nodesUnlisted` 的实例放回来（重放的事件，或者 `queued` 被拒之后才到的中间相位），那条实例
 * 就既列又计，总数说假话。
 *
 * 为什么不把它推广到所有 run：归约**照常施加**水位之下的事件（它只是不肯把水位拉回去），而
 * CLI 的冷物化把 journal 重放与在线事件喂进同一个归约。真要是在线事件先给一条 run 开了头，
 * 它整段 journal 前缀就全在水位之下——无差别收紧会让那条 run 的卡片空着。这两处窟窿都以
 * 「此前发生过拒绝或淘汰」为前提，也就是 `truncated`，所以按它收口不动界下的任何一条路径。
 */
export function admitsNewEntry(run: WorkflowRunState, live: boolean): boolean {
  return run.truncated !== true || live;
}

/**
 * actor 表满时给一个**活的新人**腾位：淘汰一个已完成组。表没满、新人其实已在表里、或者一个
 * 已完成组都没有时，原样返回（调用方随后照旧 upsert，触界仍然是拒新）。
 *
 * 出生只挤得动**已完成**的：一个还排着队的新人凭什么把另一个还排着队的挤掉——两个都没开工，
 * 换谁上表都是同一条没有信息量的记录。空闲组只在 activation（真的开工了）面前让位。
 */
export function withRoomForActor(
  run: WorkflowRunState,
  ref: InstanceRef,
  limits: WorkflowRunEntryLimits = WORKFLOW_RUNS_LIMITS,
): WorkflowRunState {
  if (run.actors.length < limits.maxActors) return run;
  if (run.actors.some((actor) => sameInstance(actor, ref))) return run;
  const victim = pickVictim(listedGroups(run).filter((group) => group.finished));
  return victim === undefined ? run : evictGroup(run, victim, limits);
}

/**
 * 一条节点事件的入座：腾位、B2 的拒绝、以及带出生事实的派发（activation）三件事的唯一入口。
 *
 * 归约主文件因此只需要把事件原样交过来，不必自己判「这条该不该入座」——那条判据有三支，
 * 每一支都有一个只在溢出之后才存在的理由。
 */
export function seatWorkflowNode(
  run: WorkflowRunState,
  seat: {
    eventType: string;
    ref: InstanceRef;
    actorRef: InstanceRef | null;
    /** 带出生事实的 `node-dispatched` 才有：按那份事实铸好的 actor 条目。 */
    actor: WorkflowRunActor | null;
    /** 这条事件是这个实例的出生事件（`node-queued`，或缓存命中的 `node-settled`）。 */
    born: boolean;
    advancesWaterMark: boolean;
  },
  limits: WorkflowRunEntryLimits = WORKFLOW_RUNS_LIMITS,
): WorkflowNodeSeating {
  const byBirth = admitsNewEntry(run, seat.born && seat.advancesWaterMark);
  if (!seat.advancesWaterMark) return { run, admitNew: byBirth, activated: false };
  // 重放的事件既不腾位也不入座：下面两支都以「抬过水位」为前提。
  if (seat.eventType === "node-dispatched" && seat.actor !== null && run.truncated === true) {
    return activateInstance(run, seat.ref, seat.actor, limits);
  }
  if (seat.eventType !== "node-queued") return { run, admitNew: byBirth, activated: false };
  // B2：溢出过的 run 里，一条认不出主人的 queued 连位子都不该占——它画不出徽章（pill 按
  // run.actors 过滤），而后面被派下去的活正需要那个位子。游离节点（world-read）不在此列。
  if (
    run.truncated === true &&
    seat.actorRef !== null &&
    !run.actors.some((actor) => sameInstance(actor, seat.actorRef!))
  ) {
    return { run, admitNew: false, activated: false };
  }
  return {
    run: withRoomForNode(run, seat.ref, seat.actorRef, limits),
    admitNew: byBirth,
    activated: false,
  };
}

/**
 * node 表满时给一个**活的新人**腾位：先淘汰一个已结算的游离节点（world-read 不属于任何人的组，
 * 淘汰它只少一行），没有就淘汰一个已完成组。同样在腾不出位时原样返回。
 *
 * `owner` 是这条新节点所属的 actor。**它自己那个组绝不当受害者**：一个连做三次 ask 的子代理
 * 在第四次撞上满表时，它前三次的组看上去「已完成」，淘汰掉就等于把这个**正在被派活**的子代理
 * 从 actor 表上摘掉——新节点留在表里，指着一个不在表上的 actor，于是它一枚徽章都没有。
 * 一个刚拿到活的组，按定义就不是完成了的。
 */
function withRoomForNode(
  run: WorkflowRunState,
  ref: InstanceRef,
  owner: InstanceRef | null,
  limits: WorkflowRunEntryLimits,
): WorkflowRunState {
  if (run.nodes.length < limits.maxNodes) return run;
  if (run.nodes.some((node) => sameInstance(node, ref))) return run;
  const loose = pickVictim(looseSettledNodes(run));
  if (loose !== undefined) return evictSingleNode(run, loose, limits);
  const victim = pickVictim(spareGroups(run, owner).filter((group) => group.finished));
  return victim === undefined ? run : evictGroup(run, victim, limits);
}

/**
 * **派发即入座。** 一条带着出生事实的 `node-dispatched`（引擎在派发那一刻重发这条实例的
 * `node-queued` 与它子代理的 `actor-created` 携带过的同一份事实）把表外的实例放回节点表，
 * 需要时连它的子代理一起放回 actor 表。
 *
 * 腾位的顺序是「先 actor 位、后节点位」，两步各自判各自的：为 actor 位淘汰掉一个**组**会连着
 * 空出至少一行节点，而淘汰一个**零节点** actor 一行都不空——所以第二步照样要重新看一眼表长。
 * 腾不出位就整条拒绝（此前那步淘汰随之作废，返回的是原样的 run），**不**只把节点放进去——
 * 一条指着表外 actor 的节点恰好是这条规则要消灭的东西。
 */
function activateInstance(
  run: WorkflowRunState,
  ref: InstanceRef,
  actor: WorkflowRunActor,
  limits: WorkflowRunEntryLimits,
): WorkflowNodeSeating {
  const nodeListed = run.nodes.some((node) => sameInstance(node, ref));
  const actorListed = run.actors.some((listed) => sameInstance(listed, actor));
  if (nodeListed && actorListed) return { run, admitNew: true, activated: false };
  let next = run;
  if (!actorListed && next.actors.length >= limits.maxActors) {
    const victim = pickGroupVictim(next, null, true);
    if (victim === undefined) return { run, admitNew: false, activated: false };
    next = evictGroup(next, victim, limits);
  }
  if (!nodeListed && next.nodes.length >= limits.maxNodes) {
    // 顺位：自己名下最老的那条已结算节点 > 已结算的游离节点 > 别人的组。先丢自己的历史，
    // 是因为丢它只少一行、而且 actor 还在表上（徽章不动）——一个子代理在拿走别人那一行之前
    // 先交出自己的。少了这一条，一个连做 k 次 ask 的子代理会被**自己**已经跑完的那些活挡在
    // 表外：它们既不是可淘汰的组（自己那个组不当受害者），又占着位子。
    const own = ownSettledNodes(next, actor)[0];
    if (own !== undefined) next = evictSingleNode(next, own, limits);
    else {
      const loose = pickVictim(looseSettledNodes(next));
      if (loose !== undefined) next = evictSingleNode(next, loose, limits);
      else {
        // 零节点 actor 在这里帮不上忙（它腾的是 actor 位，不是节点位），所以不许它当受害者。
        const victim = pickGroupVictim(next, actor, false);
        if (victim === undefined) return { run, admitNew: false, activated: false };
        next = evictGroup(next, victim, limits);
      }
    }
  }
  if (!actorListed) {
    // 回到表上的子代理从它那一格里减回去（workflow-runs-unlisted.ts）：它不再是表外的一个。
    next = withUnlistedBuckets(
      { ...next, actors: [...next.actors, actor] },
      addToUnlistedBucket(next.unlistedByPhase, actor.phaseName, { actors: -1 }, limits.maxPhases),
    );
  }
  return { run: next, admitNew: true, activated: !nodeListed };
}

/**
 * 一个**被拒的** `actor-created`：run 级没有 actor 计数器，它唯一的痕迹就是自己那一格。
 * 这一格随后可加可减——它说的是「此刻不在表上的子代理数」，不是历史累计。
 */
export function absorbRefusedActor(
  run: WorkflowRunState,
  phaseName: string | undefined,
  limits: WorkflowRunEntryLimits = WORKFLOW_RUNS_LIMITS,
): WorkflowRunState {
  return withUnlistedBuckets(
    run,
    addToUnlistedBucket(run.unlistedByPhase, phaseName, { actors: 1 }, limits.maxPhases),
  );
}

/**
 * 一条**出生即结算**的节点被拒之表外（缓存命中的 `node-settled`，它自己就是出生事件）：
 * 记进它出生阶段那一格，并按孤儿规则把它那个一条已列节点都没有的 actor 一起摘掉。
 *
 * actor 本来就不在表上时**只**记节点那一格：那个子代理早已作为 `actors` 计在**它自己**的出生
 * 阶段上，而节点的阶段戳未必是同一个；何况一个有两次缓存命中的子代理会因此被记两次「已结束」。
 * 记不准的归属不如不记——它仍然是个未列出的子代理，读面把它算作 pending，直到它重新上表。
 * run 级两个计数器不在这里加——那是 `countUnlistedInstance` 的活，两处加会翻倍。
 */
export function absorbRefusedSettledNode(
  run: WorkflowRunState,
  node: WorkflowRunNode,
  limits: WorkflowRunEntryLimits = WORKFLOW_RUNS_LIMITS,
): WorkflowRunState {
  let buckets = addToUnlistedBucket(
    run.unlistedByPhase,
    node.phaseName,
    { settled: 1 },
    limits.maxPhases,
  );
  const owner =
    node.actorSiteId === undefined || node.actorOrdinal === undefined
      ? null
      : { siteId: node.actorSiteId, ordinal: node.actorOrdinal };
  const index = owner === null ? -1 : run.actors.findIndex((actor) => sameInstance(actor, owner));
  const actor = index < 0 ? undefined : run.actors[index]!;
  const orphan = actor !== undefined && !ownsListedNode(run, actor);
  if (orphan) {
    // 孤儿是可归属的、而且只发生一次：这个 actor 就在表上，它的出生阶段是它自己带的那个。
    buckets = addToUnlistedBucket(
      buckets,
      actor.phaseName,
      { actors: 1, actorsSettled: 1, actorsFailed: isFailed(node) ? 1 : 0 },
      limits.maxPhases,
    );
  }
  return withUnlistedBuckets(
    orphan ? { ...run, actors: run.actors.filter((_, position) => position !== index) } : run,
    buckets,
  );
}

/**
 * 新一世的两张表。**溢出过的 run 从空表重开**：重臂会把整段脚本前缀再发一遍，而只有空表才能
 * 让每条实例在这一世要么被列、要么被计，恰好一次。留着一张缺过条目的表则两头都算——前缀里
 * 那条被淘汰的实例先进了 `nodesUnlisted`，重发时又落回表里。
 *
 * 没溢出过的 run 原样保留（连引用都不换）：普通 resume 的历史不该被抹掉。
 */
export function workflowRunTablesForNewLife(run: WorkflowRunState): {
  actors: WorkflowRunActor[];
  nodes: WorkflowRunNode[];
} {
  if (run.truncated !== true) return { actors: run.actors, nodes: run.nodes };
  return { actors: [], nodes: [] };
}

/**
 * 一次 activation 的组受害者：已完成组 > 空闲组 > 零节点 actor。`owner` 那个组永远排除在外。
 *
 * `allowZeroNode` 只有 **actor 位**那一支传 true：一个零节点 actor 走了只空出一个 actor 位、
 * 一行节点都不空，拿它去顶节点位会让调用方以为腾到了位子，实际那条节点仍然进不去。
 */
function pickGroupVictim(
  run: WorkflowRunState,
  owner: InstanceRef | null,
  allowZeroNode: boolean,
): Group | undefined {
  const groups = spareGroups(run, owner);
  return (
    pickVictim(groups.filter((group) => group.finished)) ??
    // 空闲组取表内**最靠后**的：FIFO 下最后建出来的那个最后才轮到派活，它的位子最不急着用。
    groups.filter((group) => group.idle).at(-1) ??
    // 零节点 actor 同理取最靠后的，而且是最后一档：它没有节点、没有分数、表里也没有历史，
    // 淘汰它读者看不见任何损失，而它自己下一次被派活时会带着事实回来。少了这一档，一次
    // resume 之后的宽 fan-out 会卡死——空表重开、前缀把 2000 个 actor 重新建出来、命中缓存的
    // 结算又不带 actor，于是一张全是零节点 actor 的表谁都淘汰不动，此后每一次派发都被拒。
    (allowZeroNode ? groups.filter((group) => group.zeroNode).at(-1) : undefined)
  );
}

function spareGroups(run: WorkflowRunState, owner: InstanceRef | null): Group[] {
  const groups = listedGroups(run);
  if (owner === null) return groups;
  return groups.filter((group) => !sameInstance(run.actors[group.index]!, owner));
}

/**
 * 类内的排序：未失败的先走（失败是读者唯一还想找回来的已结算事实），然后取候选最多的那个
 * 阶段（界花在条目拥挤的地方），最后取表内最靠前的。纯函数，所以冷回放淘汰出同一个集合。
 */
function pickVictim<T extends Candidate>(candidates: readonly T[]): T | undefined {
  if (candidates.length === 0) return undefined;
  const unfailed = candidates.filter((candidate) => !candidate.failed);
  const pool = unfailed.length > 0 ? unfailed : candidates;
  const crowd = new Map<string, number>();
  // 阶段名不可能是空串（schema 的 min(1)），所以空串拿来当「无阶段」那一格的键不会撞车。
  for (const candidate of pool) {
    const key = candidate.phaseName ?? "";
    crowd.set(key, (crowd.get(key) ?? 0) + 1);
  }
  let best = pool[0]!;
  let bestCrowd = crowd.get(best.phaseName ?? "") ?? 0;
  for (const candidate of pool) {
    const size = crowd.get(candidate.phaseName ?? "") ?? 0;
    // 只在**严格**更拥挤时换人，于是同分时留下的是表内最靠前的那个。
    if (size > bestCrowd) {
      best = candidate;
      bestCrowd = size;
    }
  }
  return best;
}

/**
 * 表里全部**非 live** 的组，按 actor 表序。有至少一条已列节点是成组的前提——一个还没拿到活的
 * actor 不是任何人的候选（它的 `node-queued` 可能正在路上）。
 *
 * 分两类，按这个子代理**此刻**在做什么：一条排队中的节点都没有 = 它的活干完了（finished）；
 * 有排队中的节点 = 它在等槽位（idle），名下另有几条已结算的 ask 不改变这件事。一个连做三次
 * ask 的子代理跑完第一次、第二次还排着队时正是后者——按「全部节点都排着队」认它，它就成了
 * 一个既不 live 又谁都淘汰不动的组，于是一张塞满这种组的表会把真正在跑的新人挡在门外，
 * 那恰好是这套规则要消灭的症状（生成的引擎形状事件流里每条 run 会因此漏掉 2–4 个在跑的子代理）。
 */
function listedGroups(run: WorkflowRunState): Group[] {
  const owned = new Map<
    string,
    { nodeIndexes: number[]; live: boolean; queued: boolean; failed: boolean }
  >();
  run.nodes.forEach((node, index) => {
    if (node.actorSiteId === undefined || node.actorOrdinal === undefined) return;
    const key = instanceKey({ siteId: node.actorSiteId, ordinal: node.actorOrdinal });
    const bucket = owned.get(key) ?? { nodeIndexes: [], live: false, queued: false, failed: false };
    bucket.nodeIndexes.push(index);
    if (node.phase === "queued") bucket.queued = true;
    else if (node.phase !== "settled") bucket.live = true;
    if (isFailed(node)) bucket.failed = true;
    owned.set(key, bucket);
  });
  const groups: Group[] = [];
  run.actors.forEach((actor, index) => {
    const bucket = owned.get(instanceKey(actor));
    if (bucket?.live === true) return;
    groups.push({
      index,
      phaseName: actor.phaseName,
      failed: bucket?.failed ?? false,
      nodeIndexes: bucket?.nodeIndexes ?? [],
      finished: bucket !== undefined && !bucket.queued,
      idle: bucket?.queued === true,
      // 一条已列节点都没有：只有 activation 的 actor 位那一支拿它当受害者（见 pickGroupVictim），
      // 出生那两条路径都只认 `finished`，所以这一档不会在界之下改变任何东西。
      zeroNode: bucket === undefined,
    });
  });
  return groups;
}

/** 游离节点：没有 actor 的已列节点（world-read）。只有已结算的才是候选。 */
function looseSettledNodes(run: WorkflowRunState): Candidate[] {
  const candidates: Candidate[] = [];
  run.nodes.forEach((node, index) => {
    if (node.actorSiteId !== undefined || node.phase !== "settled") return;
    candidates.push({ index, phaseName: node.phaseName, failed: isFailed(node) });
  });
  return candidates;
}

/**
 * 新人**自己**名下已结算的节点，按表序（最靠前 = 最老的那次 ask）。
 *
 * 不走 {@link pickVictim}：这一类里的取舍不是「哪个最该走」而是「哪段历史最旧」，而最旧的那条
 * 恰好是读者最不会回头找的。整组仍然绝不当受害者——这里丢的是行，不是人。
 */
function ownSettledNodes(run: WorkflowRunState, owner: InstanceRef): Candidate[] {
  const candidates: Candidate[] = [];
  run.nodes.forEach((node, index) => {
    if (node.actorSiteId !== owner.siteId || node.actorOrdinal !== owner.ordinal) return;
    if (node.phase !== "settled") return;
    candidates.push({ index, phaseName: node.phaseName, failed: isFailed(node) });
  });
  return candidates;
}

function ownsListedNode(run: WorkflowRunState, actor: WorkflowRunActor): boolean {
  return run.nodes.some(
    (node) => node.actorSiteId === actor.siteId && node.actorOrdinal === actor.ordinal,
  );
}

function instanceKey(ref: InstanceRef): string {
  return `${ref.siteId}\0${ref.ordinal}`;
}

/** 整组离场：actor 与它全部节点在**同一次**归约里从两张表上消失，其余条目保序。 */
function evictGroup(
  run: WorkflowRunState,
  group: Group,
  limits: WorkflowRunEntryLimits,
): WorkflowRunState {
  const actor = run.actors[group.index]!;
  const dropped = new Set(group.nodeIndexes);
  const evicted = group.nodeIndexes.map((index) => run.nodes[index]!);
  // 已完成组走的时候带着「这个子代理已经结束了」；空闲组只是让位，它的活还没开始，往后还会
  // 在自己被派活的那一刻回到表上（activation），所以不记 actorsSettled。
  return {
    ...withUnlistedEvictions(
      run,
      evicted,
      {
        phaseName: actor.phaseName,
        actors: 1,
        ...(group.finished ? { actorsSettled: 1, actorsFailed: group.failed ? 1 : 0 } : {}),
      },
      limits,
    ),
    actors: run.actors.filter((_, index) => index !== group.index),
    nodes: run.nodes.filter((_, index) => !dropped.has(index)),
    truncated: true,
  };
}

/**
 * 单独一行节点离场：一条已结算的游离节点，或者新人自己名下最老的那条已结算节点。
 *
 * 两处用同一条记账，因为它们对**人**的账毫无影响：没有 actor 离场，所以只有节点那三笔
 * （run 级两个计数器 + 这条节点出生阶段那一格的 `settled`）。
 */
function evictSingleNode(
  run: WorkflowRunState,
  candidate: Candidate,
  limits: WorkflowRunEntryLimits,
): WorkflowRunState {
  const node = run.nodes[candidate.index]!;
  return {
    ...withUnlistedEvictions(run, [node], undefined, limits),
    nodes: run.nodes.filter((_, index) => index !== candidate.index),
    truncated: true,
  };
}

/**
 * 被淘汰的条目记进 run 级两个计数器与各自的出生阶段那一格。
 *
 * `nodesUnlisted` 按淘汰掉的**全部**节点加，`nodesUnlistedSettled` 只按其中**已结算**的那些：
 * 一个空闲组走的时候带的是还排着队的节点，它们还没结算，算进去会让完成度虚高。
 */
function withUnlistedEvictions(
  run: WorkflowRunState,
  nodes: readonly WorkflowRunNode[],
  agent: EvictedAgent | undefined,
  limits: WorkflowRunEntryLimits,
): WorkflowRunState {
  let buckets = run.unlistedByPhase;
  if (agent !== undefined) {
    const { phaseName, ...delta } = agent;
    buckets = addToUnlistedBucket(buckets, phaseName, delta, limits.maxPhases);
  }
  let settledCount = 0;
  for (const node of nodes) {
    if (node.phase !== "settled") continue;
    settledCount += 1;
    buckets = addToUnlistedBucket(buckets, node.phaseName, { settled: 1 }, limits.maxPhases);
  }
  const settledTotal = (run.usage.nodesUnlistedSettled ?? 0) + settledCount;
  return withUnlistedBuckets(
    {
      ...run,
      usage: {
        ...run.usage,
        nodesUnlisted: (run.usage.nodesUnlisted ?? 0) + nodes.length,
        // 零时整个键缺席（与 workflow-runs-caps.ts 同规）。
        ...(settledTotal > 0 ? { nodesUnlistedSettled: settledTotal } : {}),
      },
    },
    buckets,
  );
}
