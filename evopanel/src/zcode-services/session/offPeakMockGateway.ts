/* eslint-disable max-lines -- mock 网关集中模拟 availability、ticket、status、settle 与 messages，拆分会割裂共享票据状态。 */
/* off-peak 进程内 mock 网关。
   本地起 127.0.0.1 http 服务完整模拟 额度快照/取号/批量状态/结算/messages，
   真实 HTTP client 与 idle plan provider 的 baseURL 只需指到本网关 origin——生产代码路径
   与联调完全一致，联调时删掉 ZCODE_OFFPEAK_MOCK 开关即可。

   ⚠ messages 端点在准入后把请求原样代理到 resolveUpstream() 指定的真实模型端点
   （通常是用户 coding plan 的 anthropic 兼容端点）——mock 模式下跑的是真模型、
   计费走用户自己的 key，仅用于开发/演示。

   状态机（对齐两轴的服务端轴）：
   take → queued（FIFO position）；status 轮询触发晋级（轮询即 Promote）：
   取号超过 readyDelayMs → ready（readyDeadline = +readyTtlMs）；ready 超时未发首个
   message → expired；首个 message 准入 → active（activeDeadline = +activeMs）；
   active 到期 → expired，messages 返回 400/3102；settle → settled（幂等）。
   messages 准入前可注入 N 次 429/3105 + Retry-After（模拟资源满载细阀）。 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { ServiceLogger } from "../logger/serviceLogger.js";

interface OffPeakMockGatewayOptions {
  /** queued→ready 的晋级延迟；默认 15s（演示低峰等待）。 */
  readyDelayMs?: number;
  /** ready 后须发首个 message 的窗口；默认 5min。 */
  readyTtlMs?: number;
  /** active 硬顶；默认 3h（调小可演示 400/3102 自动续跑）。 */
  activeMs?: number;
  /** 每张票准入前先回多少次 429/3105；默认 0。 */
  queue429Count?: number;
  /** 前 N 次取号直接回 3103（免费额度耗尽），用于验证错误提示后仍可重试；默认 0。 */
  quotaExhaustedCount?: number;
  /** availability 与真实取号保持不可用的时长；默认 0，E2E 用于验证服务端快照置灰。 */
  availabilityBlockedMs?: number;
  /** 429 的 Retry-After 秒数；默认 5。 */
  retryAfterS?: number;
  /** status/take 下发的 next_poll_after 秒数；默认 5。 */
  nextPollS?: number;
  /** 仅供确定性 E2E 使用的 messages 脚本；生产与普通 mock 演示均不设置。 */
  scenario?: "foreground-subagents" | "capture" | "invalid-ticket";
}

interface OffPeakMockGatewayDeps {
  logger: ServiceLogger;
  /**
   * 准入后 messages 的转发目标：完整 messages URL + 出站头（含上游鉴权）。
   * 返回 null = 不代理，直接回一段固定的 Anthropic 响应（E2E/离线演示：agent loop 立即完成，
   * 不依赖真实模型 key）。
   */
  resolveUpstream: () => Promise<{
    url: string;
    headers: Record<string, string>;
  } | null>;
}

interface MockTicket {
  ticketId: string;
  taskId: string;
  state: "queued" | "ready" | "active" | "expired" | "settled";
  takenAt: number;
  readyAt?: number;
  readyDeadline?: number;
  activeDeadline?: number;
  queue429Remaining: number;
  /** FIFO 序号，用于 position 计算。 */
  seq: number;
}

export function isOffPeakMockEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["ZCODE_OFFPEAK_MOCK"] === "1";
}

/** 环境变量覆盖数值选项（真机演示用；测试直接传 options）。 */
function readEnvOptions(env: NodeJS.ProcessEnv): OffPeakMockGatewayOptions {
  const num = (key: string): number | undefined => {
    const raw = env[key];
    if (!raw) return undefined;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  };
  const scenarioValue = env["ZCODE_OFFPEAK_MOCK_SCENARIO"];
  const scenario =
    scenarioValue === "foreground-subagents" ||
    scenarioValue === "capture" ||
    scenarioValue === "invalid-ticket"
      ? scenarioValue
      : undefined;
  return {
    ...(num("ZCODE_OFFPEAK_MOCK_READY_DELAY_MS") !== undefined
      ? { readyDelayMs: num("ZCODE_OFFPEAK_MOCK_READY_DELAY_MS") }
      : {}),
    ...(num("ZCODE_OFFPEAK_MOCK_READY_TTL_MS") !== undefined
      ? { readyTtlMs: num("ZCODE_OFFPEAK_MOCK_READY_TTL_MS") }
      : {}),
    ...(num("ZCODE_OFFPEAK_MOCK_ACTIVE_MS") !== undefined
      ? { activeMs: num("ZCODE_OFFPEAK_MOCK_ACTIVE_MS") }
      : {}),
    ...(num("ZCODE_OFFPEAK_MOCK_QUEUE_429_COUNT") !== undefined
      ? { queue429Count: num("ZCODE_OFFPEAK_MOCK_QUEUE_429_COUNT") }
      : {}),
    ...(num("ZCODE_OFFPEAK_MOCK_QUOTA_COUNT") !== undefined
      ? { quotaExhaustedCount: num("ZCODE_OFFPEAK_MOCK_QUOTA_COUNT") }
      : {}),
    ...(num("ZCODE_OFFPEAK_MOCK_AVAILABILITY_BLOCK_MS") !== undefined
      ? {
          availabilityBlockedMs: num("ZCODE_OFFPEAK_MOCK_AVAILABILITY_BLOCK_MS"),
        }
      : {}),
    ...(num("ZCODE_OFFPEAK_MOCK_RETRY_AFTER_S") !== undefined
      ? { retryAfterS: num("ZCODE_OFFPEAK_MOCK_RETRY_AFTER_S") }
      : {}),
    ...(num("ZCODE_OFFPEAK_MOCK_NEXT_POLL_S") !== undefined
      ? { nextPollS: num("ZCODE_OFFPEAK_MOCK_NEXT_POLL_S") }
      : {}),
    ...(scenario ? { scenario } : {}),
  };
}

interface OffPeakMockCapturedRequest {
  hasApiKey: boolean;
  hasAuthorization: boolean;
  hasCodingPlanApiKey: boolean;
  maxTokens?: number;
  model?: string;
  requestJson: unknown;
  stage: string;
  ticketId: string;
  organization?: string;
  project?: string;
}

interface OffPeakMockGatewayHandle {
  origin: string;
  port: number;
  /** true = 端口已被另一个 host 的网关占用，本 handle 只是指向它（close 为 no-op）。 */
  external: boolean;
  close: () => Promise<void>;
}

/** 固定端口（可用 ZCODE_OFFPEAK_MOCK_PORT 覆盖）：多窗口多 host 时共享同一份 mock 票据状态。 */
const DEFAULT_MOCK_PORT = 45_197;

export async function startOffPeakMockGateway(
  deps: OffPeakMockGatewayDeps,
  options?: OffPeakMockGatewayOptions & { port?: number },
): Promise<OffPeakMockGatewayHandle> {
  const config = {
    readyDelayMs: 15_000,
    readyTtlMs: 5 * 60_000,
    activeMs: 3 * 60 * 60_000,
    queue429Count: 0,
    quotaExhaustedCount: 0,
    availabilityBlockedMs: 0,
    retryAfterS: 5,
    nextPollS: 5,
    ...readEnvOptions(process.env),
    ...options,
  };
  const tickets = new Map<string, MockTicket>();
  let quotaInjectionsRemaining = config.quotaExhaustedCount;
  const availabilityBlockedUntil = Date.now() + config.availabilityBlockedMs;
  /** taskId → 最新一张票（同 task_id 重新取号后旧票作废）。 */
  const latestByTask = new Map<string, string>();
  const capturedRequests: OffPeakMockCapturedRequest[] = [];
  let invalidTicketRequests = 0;
  let seqCounter = 0;

  /** 懒惰推进时间驱动的状态（轮询/messages 时评估，无后台计时器）。 */
  function advance(ticket: MockTicket, now: number): void {
    if (ticket.state === "queued" && now - ticket.takenAt >= config.readyDelayMs) {
      ticket.state = "ready";
      ticket.readyAt = now;
      ticket.readyDeadline = now + config.readyTtlMs;
    }
    if (
      ticket.state === "ready" &&
      ticket.readyDeadline !== undefined &&
      now > ticket.readyDeadline
    ) {
      ticket.state = "expired";
    }
    if (
      ticket.state === "active" &&
      ticket.activeDeadline !== undefined &&
      now > ticket.activeDeadline
    ) {
      ticket.state = "expired";
    }
  }

  /** 排队位次 = 前面还有多少张未晋级的活票。 */
  function positionOf(ticket: MockTicket): number {
    let ahead = 0;
    for (const other of tickets.values()) {
      if (other.state === "queued" && other.seq < ticket.seq) ahead += 1;
    }
    return ahead + 1;
  }

  function json(
    res: ServerResponse,
    status: number,
    body: unknown,
    headers?: Record<string, string>,
  ): void {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  }

  async function readBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    try {
      return text ? JSON.parse(text) : {};
    } catch {
      return {};
    }
  }

  async function handleTake(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = (await readBody(req)) as { task_id?: string };
    const taskId = body.task_id;
    if (!taskId) {
      json(res, 400, { code: 3000, msg: "task_id required" });
      return;
    }
    const now = Date.now();
    if (now < availabilityBlockedUntil) {
      json(res, 429, {
        code: 3103,
        msg: "free tier limit reached",
        data: { next_take_at: availabilityBlockedUntil },
      });
      return;
    }
    if (quotaInjectionsRemaining > 0) {
      quotaInjectionsRemaining -= 1;
      json(res, 429, {
        code: 3103,
        msg: "free tier limit reached",
        data: { next_take_at: now + 60_000 },
      });
      return;
    }
    // 同 task_id 重新取号：旧票直接作废（真实服务端旧票已自然终态）。
    const previous = latestByTask.get(taskId);
    if (previous) {
      const old = tickets.get(previous);
      if (old && (old.state === "queued" || old.state === "ready" || old.state === "active")) {
        old.state = "expired";
      }
    }
    seqCounter += 1;
    const ticket: MockTicket = {
      ticketId: `mock-ticket-${seqCounter}`,
      taskId,
      state: "queued",
      takenAt: now,
      queue429Remaining: config.queue429Count,
      seq: seqCounter,
    };
    // readyDelayMs=0 时取号即 ready（低峰空闲直接晋级的形态）。
    advance(ticket, now);
    tickets.set(ticket.ticketId, ticket);
    latestByTask.set(taskId, ticket.ticketId);
    deps.logger.info(
      `mock gateway take task=${taskId} ticket=${ticket.ticketId} state=${ticket.state}`,
    );
    json(res, 200, {
      ticket_id: ticket.ticketId,
      task_id: taskId,
      state: ticket.state,
      accepted: true,
      position: ticket.state === "queued" ? positionOf(ticket) : null,
      next_poll_after: config.nextPollS,
      queued_at: now,
      ...(ticket.readyDeadline ? { ready_deadline: ticket.readyDeadline } : {}),
    });
  }

  function handleAvailability(res: ServerResponse): void {
    const now = Date.now();
    json(res, 200, {
      can_take_number: now >= availabilityBlockedUntil,
      ...(now < availabilityBlockedUntil ? { next_take_at: availabilityBlockedUntil } : {}),
    });
  }

  async function handleStatus(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = (await readBody(req)) as { ticket_ids?: string[] };
    const ids = Array.isArray(body.ticket_ids) ? body.ticket_ids.slice(0, 100) : [];
    const now = Date.now();
    const entries = ids.map((id) => {
      const ticket = tickets.get(id);
      if (!ticket) return { ticket_id: id, state: "not_found" as const };
      advance(ticket, now);
      return {
        ticket_id: ticket.ticketId,
        task_id: ticket.taskId,
        state: ticket.state,
        position: ticket.state === "queued" ? positionOf(ticket) : null,
        ...(ticket.activeDeadline ? { active_deadline: ticket.activeDeadline } : {}),
      };
    });
    json(res, 200, { next_poll_after: config.nextPollS, tickets: entries });
  }

  function handleSettle(res: ServerResponse, ticketId: string): void {
    const ticket = tickets.get(ticketId);
    if (ticket) ticket.state = "settled";
    // 幂等：未知票也 200。
    json(res, 200, {
      ticket_id: ticketId,
      state: "settled",
      settled_at: Date.now(),
    });
  }

  async function handleMessages(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const ticketId = String(req.headers["x-off-peak-ticket-id"] ?? "");
    const ticket = tickets.get(ticketId);
    const now = Date.now();
    if (ticket) advance(ticket, now);
    if (!ticket || ticket.state === "expired" || ticket.state === "settled") {
      json(res, 400, { code: 3102, msg: "wrong off-peak ticket" });
      return;
    }
    if (config.scenario === "invalid-ticket") {
      // 让 E2E 走真实的 3102 终态路径：客户端必须重取票/保留原任务身份，
      // 且不能把失败的闲时请求偷偷改发到普通 Chat provider。
      invalidTicketRequests += 1;
      json(res, 400, { code: 3102, msg: "wrong off-peak ticket" });
      return;
    }
    if (ticket.state === "queued") {
      // 粗阀未开就来了 message：按细阀排队应答（客户端不应走到这，防御分支）。
      json(
        res,
        429,
        { code: 3105, msg: "not ready" },
        { "retry-after": String(config.retryAfterS) },
      );
      return;
    }
    if (ticket.queue429Remaining > 0) {
      ticket.queue429Remaining -= 1;
      json(
        res,
        429,
        { code: 3105, msg: "model concurrency saturated (mock)" },
        { "retry-after": String(config.retryAfterS) },
      );
      return;
    }
    if (ticket.state === "ready") {
      // ready 5min 内首个 message 即准入 active，进入 3h 窗口。
      ticket.state = "active";
      ticket.activeDeadline = now + config.activeMs;
      deps.logger.info(
        `mock gateway admitted ticket=${ticketId} activeDeadline=${ticket.activeDeadline}`,
      );
    }
    // admitted：原样代理到真实上游（SSE 透传）。
    const requestBody = await (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      return Buffer.concat(chunks);
    })();
    const requestJson = parseMockRequestJson(requestBody);
    if (config.scenario === "foreground-subagents" || config.scenario === "capture") {
      const stage = classifyForegroundSubagentScenarioRequest(requestJson);
      const maxTokens = readRequestNumber(requestJson, "max_tokens");
      const model = readRequestString(requestJson, "model");
      capturedRequests.push({
        hasApiKey: Boolean(req.headers["x-api-key"]),
        hasAuthorization: Boolean(req.headers.authorization),
        hasCodingPlanApiKey: Boolean(req.headers["x-coding-plan-api-key"]),
        ...(maxTokens !== undefined ? { maxTokens } : {}),
        ...(model ? { model } : {}),
        requestJson,
        stage,
        ticketId,
        ...(typeof req.headers["bigmodel-organization"] === "string"
          ? { organization: req.headers["bigmodel-organization"] }
          : {}),
        ...(typeof req.headers["bigmodel-project"] === "string"
          ? { project: req.headers["bigmodel-project"] }
          : {}),
      });
      const scripted =
        config.scenario === "foreground-subagents"
          ? buildForegroundSubagentScenarioResponse(stage)
          : null;
      if (scripted) {
        respondWithAnthropicMock(res, scripted, readRequestBoolean(requestJson, "stream"));
        return;
      }
    }
    let upstream: { url: string; headers: Record<string, string> } | null;
    try {
      upstream = await deps.resolveUpstream();
    } catch (error) {
      deps.logger.warn("mock gateway resolveUpstream failed:", error);
      upstream = null;
    }
    if (!upstream) {
      // 离线/E2E：回一段固定的非流式 Anthropic 响应，agent loop 立即拿到 stop 收尾。
      json(res, 200, {
        id: "msg_offpeak_mock",
        type: "message",
        role: "assistant",
        model: "offpeak-mock",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Off-peak mock run completed." }],
        usage: { input_tokens: 1, output_tokens: 1 },
      });
      return;
    }
    try {
      const upstreamResponse = await fetch(upstream.url, {
        method: "POST",
        headers: {
          "content-type": String(req.headers["content-type"] ?? "application/json"),
          ...(req.headers["anthropic-version"]
            ? { "anthropic-version": String(req.headers["anthropic-version"]) }
            : {}),
          ...upstream.headers,
        },
        body: new Uint8Array(requestBody),
      });
      const responseHeaders: Record<string, string> = {};
      upstreamResponse.headers.forEach((value, key) => {
        // hop-by-hop 头不透传。
        if (
          ["transfer-encoding", "connection", "content-length", "content-encoding"].includes(key)
        ) {
          return;
        }
        responseHeaders[key] = value;
      });
      res.writeHead(upstreamResponse.status, responseHeaders);
      if (!upstreamResponse.body) {
        res.end();
        return;
      }
      const reader = upstreamResponse.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
      res.end();
    } catch (error) {
      deps.logger.warn("mock gateway upstream proxy failed:", error);
      json(res, 502, { code: 2001, msg: "mock upstream proxy failed" });
    }
  }

  const server: Server = createServer((req, res) => {
    const url = req.url ?? "";
    void (async () => {
      if (
        req.method === "GET" &&
        url === "/__e2e/off-peak/requests" &&
        (config.scenario === "foreground-subagents" ||
          config.scenario === "capture" ||
          config.scenario === "invalid-ticket")
      ) {
        json(res, 200, {
          invalidTicketRequests,
          requests: capturedRequests,
        });
        return;
      }
      if (req.method === "GET" && url === "/api/v1/off-peak/ticket/availability") {
        handleAvailability(res);
        return;
      }
      if (req.method !== "POST") {
        json(res, 405, { msg: "method not allowed" });
        return;
      }
      if (url === "/api/v1/off-peak/ticket") {
        await handleTake(req, res);
        return;
      }
      if (url === "/api/v1/off-peak/ticket/status") {
        await handleStatus(req, res);
        return;
      }
      const settleMatch = /^\/api\/v1\/off-peak\/ticket\/([^/]+)\/settle$/.exec(url);
      if (settleMatch) {
        handleSettle(res, decodeURIComponent(settleMatch[1]!));
        return;
      }
      if (url === "/api/v1/off-peak/anthropic/v1/messages") {
        await handleMessages(req, res);
        return;
      }
      json(res, 404, { msg: `no mock route for ${url}` });
    })().catch((error) => {
      deps.logger.warn("mock gateway handler failed:", error);
      try {
        json(res, 500, { msg: "mock gateway internal error" });
      } catch {
        // 响应已发出，忽略。
      }
    });
  });

  const requestedPort =
    options?.port ??
    (Number(process.env["ZCODE_OFFPEAK_MOCK_PORT"]) > 0
      ? Number(process.env["ZCODE_OFFPEAK_MOCK_PORT"])
      : DEFAULT_MOCK_PORT);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(requestedPort, "127.0.0.1", () => resolve());
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      // 多窗口：另一个 host 已起网关，共用它的票据状态（票在共享 sqlite 里跨 host 流转，
      // mock 状态必须单实例，否则 A 取的票在 B 的网关查不到）。
      const origin = `http://127.0.0.1:${requestedPort}`;
      deps.logger.info(`off-peak mock gateway reusing existing instance at ${origin}`);
      return {
        origin,
        port: requestedPort,
        external: true,
        close: async () => {},
      };
    }
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("off-peak mock gateway failed to bind");
  }
  const origin = `http://127.0.0.1:${address.port}`;
  deps.logger.info(`off-peak mock gateway listening at ${origin}`);
  return {
    origin,
    port: address.port,
    external: false,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

const FOREGROUND_SUBAGENT_SCENARIO = {
  parentMarker: "E2E_OFFPEAK_SUBAGENTS_PARENT",
  parentFinal: "E2E_OFFPEAK_SUBAGENTS_PARENT_OK",
  backgroundError:
    "Idle-time tasks do not support background agents. Run this agent in the foreground.",
  children: [
    {
      stage: "child-explore",
      marker: "E2E_OFFPEAK_SUBAGENT_CHILD_EXPLORE",
      reply: "E2E_OFFPEAK_SUBAGENT_CHILD_EXPLORE_OK",
      toolId: "toolu_e2e_offpeak_explore",
      input: {
        description: "Verify Explore foreground inheritance",
        prompt:
          "E2E_OFFPEAK_SUBAGENT_CHILD_EXPLORE: reply exactly E2E_OFFPEAK_SUBAGENT_CHILD_EXPLORE_OK.",
        subagent_type: "Explore",
      },
    },
    {
      stage: "child-general-purpose",
      marker: "E2E_OFFPEAK_SUBAGENT_CHILD_GENERAL",
      reply: "E2E_OFFPEAK_SUBAGENT_CHILD_GENERAL_OK",
      toolId: "toolu_e2e_offpeak_general",
      input: {
        description: "Verify general-purpose foreground inheritance",
        prompt:
          "E2E_OFFPEAK_SUBAGENT_CHILD_GENERAL: reply exactly E2E_OFFPEAK_SUBAGENT_CHILD_GENERAL_OK.",
        subagent_type: "general-purpose",
      },
    },
    {
      stage: "child-code-search",
      marker: "E2E_OFFPEAK_SUBAGENT_CHILD_CODE_SEARCH",
      reply: "E2E_OFFPEAK_SUBAGENT_CHILD_CODE_SEARCH_OK",
      toolId: "toolu_e2e_offpeak_code_search",
      input: {
        description: "Verify custom Code Search foreground inheritance",
        prompt:
          "E2E_OFFPEAK_SUBAGENT_CHILD_CODE_SEARCH: reply exactly E2E_OFFPEAK_SUBAGENT_CHILD_CODE_SEARCH_OK.",
        subagent_type: "Code Search",
      },
    },
    {
      stage: "child-custom-inherit",
      marker: "E2E_OFFPEAK_SUBAGENT_CHILD_INHERIT",
      reply: "E2E_OFFPEAK_SUBAGENT_CHILD_INHERIT_OK",
      toolId: "toolu_e2e_offpeak_inherit",
      input: {
        description: "Verify custom inherited-model foreground agent",
        prompt:
          "E2E_OFFPEAK_SUBAGENT_CHILD_INHERIT: reply exactly E2E_OFFPEAK_SUBAGENT_CHILD_INHERIT_OK.",
        subagent_type: "E2E OffPeak Inherit Reviewer",
      },
    },
  ],
  backgrounds: [
    {
      stage: "unexpected-background-explicit",
      marker: "E2E_OFFPEAK_SUBAGENT_BACKGROUND_EXPLICIT",
      toolId: "toolu_e2e_offpeak_background_explicit",
      input: {
        description: "Verify explicit background rejection",
        prompt:
          "E2E_OFFPEAK_SUBAGENT_BACKGROUND_EXPLICIT: this child must never reach the provider.",
        run_in_background: true,
        subagent_type: "general-purpose",
      },
    },
    {
      stage: "unexpected-background-profile",
      marker: "E2E_OFFPEAK_SUBAGENT_BACKGROUND_PROFILE",
      toolId: "toolu_e2e_offpeak_background_profile",
      input: {
        description: "Verify profile background rejection",
        prompt:
          "E2E_OFFPEAK_SUBAGENT_BACKGROUND_PROFILE: this child must never reach the provider.",
        subagent_type: "E2E OffPeak Background Reviewer",
      },
    },
  ],
} as const;

function parseMockRequestJson(requestBody: Buffer): unknown {
  try {
    return JSON.parse(requestBody.toString("utf8"));
  } catch {
    return {};
  }
}

function readRequestString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" ? candidate : undefined;
}

function readRequestNumber(value: unknown, key: string): number | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined;
}

function readRequestBoolean(value: unknown, key: string): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return (value as Record<string, unknown>)[key] === true;
}

function classifyForegroundSubagentScenarioRequest(requestJson: unknown): string {
  const serialized = JSON.stringify(requestJson);
  if (
    FOREGROUND_SUBAGENT_SCENARIO.children.every((child) => serialized.includes(child.reply)) &&
    serialized.includes(FOREGROUND_SUBAGENT_SCENARIO.backgroundError)
  ) {
    return "parent-continuation";
  }
  for (const child of FOREGROUND_SUBAGENT_SCENARIO.children) {
    if (serialized.includes(child.marker)) return child.stage;
  }
  for (const background of FOREGROUND_SUBAGENT_SCENARIO.backgrounds) {
    if (serialized.includes(background.marker)) return background.stage;
  }
  if (serialized.includes(FOREGROUND_SUBAGENT_SCENARIO.parentMarker)) {
    return "parent-initial";
  }
  return "unknown";
}

function buildForegroundSubagentScenarioResponse(stage: string): AnthropicMockResponse | undefined {
  if (stage === "parent-initial") {
    return anthropicMockResponse({
      content: [
        ...FOREGROUND_SUBAGENT_SCENARIO.children.map((child) => ({
          type: "tool_use" as const,
          id: child.toolId,
          name: "Agent",
          input: child.input,
        })),
        ...FOREGROUND_SUBAGENT_SCENARIO.backgrounds.map((background) => ({
          type: "tool_use" as const,
          id: background.toolId,
          name: "Agent",
          input: background.input,
        })),
      ],
      stopReason: "tool_use",
    });
  }
  const child = FOREGROUND_SUBAGENT_SCENARIO.children.find(
    (candidate) => candidate.stage === stage,
  );
  if (child) {
    return anthropicMockResponse({
      content: [{ type: "text", text: child.reply }],
      stopReason: "end_turn",
    });
  }
  const background = FOREGROUND_SUBAGENT_SCENARIO.backgrounds.find(
    (candidate) => candidate.stage === stage,
  );
  if (background) {
    return anthropicMockResponse({
      content: [{ type: "text", text: `${background.marker}_UNEXPECTED` }],
      stopReason: "end_turn",
    });
  }
  if (stage === "parent-continuation") {
    return anthropicMockResponse({
      content: [{ type: "text", text: FOREGROUND_SUBAGENT_SCENARIO.parentFinal }],
      stopReason: "end_turn",
    });
  }
  return undefined;
}

interface AnthropicMockResponse {
  content: readonly Record<string, unknown>[];
  id: string;
  model: string;
  role: "assistant";
  stop_reason: "end_turn" | "tool_use";
  type: "message";
  usage: { input_tokens: number; output_tokens: number };
}

function anthropicMockResponse(input: {
  content: readonly Record<string, unknown>[];
  stopReason: "end_turn" | "tool_use";
}): AnthropicMockResponse {
  return {
    id: `msg_offpeak_mock_${input.stopReason}`,
    type: "message",
    role: "assistant",
    model: "offpeak-mock",
    stop_reason: input.stopReason,
    content: input.content,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

function respondWithAnthropicMock(
  res: ServerResponse,
  response: AnthropicMockResponse,
  stream: boolean,
): void {
  if (!stream) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(response));
    return;
  }

  const events: string[] = [
    anthropicSseEvent("message_start", {
      type: "message_start",
      message: { ...response, content: [], stop_reason: null },
    }),
  ];
  response.content.forEach((block, index) => {
    if (block.type === "tool_use") {
      events.push(
        anthropicSseEvent("content_block_start", {
          type: "content_block_start",
          index,
          content_block: {
            type: "tool_use",
            id: block.id,
            name: block.name,
            input: {},
          },
        }),
        anthropicSseEvent("content_block_delta", {
          type: "content_block_delta",
          index,
          delta: {
            type: "input_json_delta",
            partial_json: JSON.stringify(block.input ?? {}),
          },
        }),
        anthropicSseEvent("content_block_stop", {
          type: "content_block_stop",
          index,
        }),
      );
      return;
    }
    events.push(
      anthropicSseEvent("content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "text", text: "" },
      }),
      anthropicSseEvent("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "text_delta", text: block.text ?? "" },
      }),
      anthropicSseEvent("content_block_stop", {
        type: "content_block_stop",
        index,
      }),
    );
  });
  events.push(
    anthropicSseEvent("message_delta", {
      type: "message_delta",
      delta: { stop_reason: response.stop_reason, stop_sequence: null },
      usage: response.usage,
    }),
    anthropicSseEvent("message_stop", { type: "message_stop" }),
  );
  res.writeHead(200, {
    "cache-control": "no-cache",
    "content-type": "text/event-stream; charset=utf-8",
  });
  res.end(events.join(""));
}

function anthropicSseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
