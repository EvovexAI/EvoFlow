/**
 * v4 wire 契约一致性测试：用 zod 报错驱动的填充算法，产出最小合法的
 * ConversationSnapshot / 行 / 帧实例并验证 schema 接受——守护 vendored
 * ``@zcode/shared/zcode-protocol-v4`` 与 EvoFlow 后端（``backend/app/gateway/v4/conversation.py``）
 * 之间的 wire 契约不漂移。升级 vendored 协议后若此测试变红，后端模板需同步对齐。
 * 运行：npx vitest run tests/v4-wire-conformance.test.ts
 */
import { describe, expect, it } from "vitest";
import {
  conversationSnapshotSchema,
  conversationTopicFrameSchema,
  conversationRowSchema,
} from "@zcode/shared/zcode-protocol-v4";

type Json = Record<string, unknown>;
type ZodIssue = {
  code: string;
  path: (string | number)[];
  expected?: unknown;
  received?: unknown;
  values?: unknown[];
  options?: unknown[];
  origin?: string;
  minimum?: unknown;
};

function guessForIssue(issue: ZodIssue): { value: unknown; ok: boolean } {
  switch (issue.code) {
    case "invalid_type":
      switch (issue.expected) {
        case "string":
          return { value: "", ok: true };
        case "number":
        case "int":
        case "integer":
          return { value: 0, ok: true };
        case "boolean":
          return { value: false, ok: true };
        case "array":
          return { value: [], ok: true };
        case "object":
          return { value: {}, ok: true };
        case "null":
          return { value: null, ok: true };
        case "undefined":
          return { value: undefined, ok: true };
        default:
          return { value: null, ok: false };
      }
    case "invalid_value":
    case "invalid_literal":
    case "invalid_enum_value":
    case "invalid_union": {
      const values = issue.values ?? issue.options ?? [];
      return values.length > 0 ? { value: values[0], ok: true } : { value: null, ok: false };
    }
    case "too_small":
      return { value: typeof issue.minimum === "number" && issue.minimum > 0 ? issue.minimum : 0, ok: true };
    case "invalid_string":
      return { value: "", ok: true };
    default:
      return { value: null, ok: false };
  }
}

function setAtPath(obj: Json, path: (string | number)[], value: unknown): void {
  if (path.length === 0) return;
  let cur: unknown = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    const nextKey = path[i + 1];
    const defaultContainer = typeof nextKey === "number" ? [] : {};
    if (typeof key === "number") {
      const arr = cur as unknown[];
      if (arr[key] === undefined || arr[key] === null) arr[key] = defaultContainer;
      cur = arr[key];
    } else {
      const rec = cur as Json;
      if (rec[key] === undefined || rec[key] === null) rec[key] = defaultContainer;
      cur = rec[key];
    }
  }
  const last = path[path.length - 1];
  if (typeof last === "number") (cur as unknown[])[last] = value;
  else (cur as Json)[last] = value;
}

function buildMinimal(schema: {
  safeParse: (data: unknown) => { success: boolean; error?: { issues: ZodIssue[] } };
}): { candidate: Json; valid: boolean } {
  const candidate: Json = {};
  const lastValues = new Map<string, unknown>();
  for (let round = 0; round < 60; round++) {
    const result = schema.safeParse(candidate);
    if (result.success) return { candidate, valid: true };
    const issues = result.error?.issues ?? [];
    let changed = false;
    for (const issue of issues) {
      if (issue.path.length === 0) continue;
      const key = issue.path.join("/");
      const guess = guessForIssue(issue);
      if (!guess.ok) continue;
      setAtPath(candidate, issue.path, guess.value);
      if (lastValues.get(key) !== guess.value) {
        lastValues.set(key, guess.value);
        changed = true;
      }
    }
    if (!changed) return { candidate, valid: false };
  }
  return { candidate, valid: false };
}

describe("minimal snapshot generator", () => {
  it("generates a parse-valid minimal ConversationSnapshot", () => {
    const { candidate, valid } = buildMinimal(conversationSnapshotSchema as never);
    if (!valid) {
      const result = conversationSnapshotSchema.safeParse(candidate);
      console.error(
        "STILL INVALID (first 10 issues):",
        JSON.stringify(result.success ? [] : result.error?.issues.slice(0, 10), null, 1),
      );
    }
    expect(valid).toBe(true);
    console.log("MINIMAL_SNAPSHOT_JSON_START");
    console.log(JSON.stringify(candidate, null, 1));
    console.log("MINIMAL_SNAPSHOT_JSON_END");
  });

  it("validates a full topic frame wrapping the minimal snapshot", () => {
    const snap = buildMinimal(conversationSnapshotSchema as never);
    const frame = {
      topic: "conversation/test-session",
      subscriptionId: "sub-1",
      fromSeq: 0,
      toSeq: 1,
      sentAt: Date.now(),
      payload: { kind: "snapshot", snapshot: snap.candidate },
    };
    const parsed = conversationTopicFrameSchema.safeParse(frame);
    if (!parsed.success) {
      console.error(
        "FRAME INVALID (first 8 issues):",
        JSON.stringify(parsed.error?.issues.slice(0, 8), null, 1),
      );
    }
    expect(parsed.success).toBe(true);
  });

  it("generates parse-valid minimal rows for demo kinds", () => {
    const seeds: Array<{ kind: string; rowId: number }> = [
      { kind: "turnHeader", rowId: 1 },
      { kind: "userInput", rowId: 2 },
      { kind: "assistantText", rowId: 3 },
      { kind: "reasoning", rowId: 4 },
      { kind: "toolCall", rowId: 5 },
    ];
    const rows: unknown[] = [];
    for (const seed of seeds) {
      const { candidate, valid } = buildMinimalWithSeed(conversationRowSchema as never, seed);
      if (!valid) {
        const result = conversationRowSchema.safeParse(candidate);
        console.error(
          `ROW ${seed.kind} STILL INVALID:`,
          JSON.stringify(result.success ? [] : result.error?.issues.slice(0, 6), null, 1),
        );
      }
      expect(valid).toBe(true);
      rows.push(candidate);
    }
    console.log("MINIMAL_ROWS_JSON_START");
    console.log(JSON.stringify(rows, null, 1));
    console.log("MINIMAL_ROWS_JSON_END");
  });
});

/** 同 buildMinimal，但以种子对象为起点（保留 discriminated union 的 kind 等关键字段）。 */
function buildMinimalWithSeed(
  schema: {
    safeParse: (data: unknown) => { success: boolean; error?: { issues: ZodIssue[] } };
  },
  seed: Json,
): { candidate: Json; valid: boolean } {
  const candidate: Json = { ...seed };
  const lastValues = new Map<string, unknown>();
  for (let round = 0; round < 60; round++) {
    const result = schema.safeParse(candidate);
    if (result.success) return { candidate, valid: true };
    const issues = result.error?.issues ?? [];
    let changed = false;
    for (const issue of issues) {
      if (issue.path.length === 0) continue;
      const key = issue.path.join("/");
      const guess = guessForIssue(issue);
      if (!guess.ok) continue;
      setAtPath(candidate, issue.path, guess.value);
      if (lastValues.get(key) !== guess.value) {
        lastValues.set(key, guess.value);
        changed = true;
      }
    }
    if (!changed) return { candidate, valid: false };
  }
  return { candidate, valid: false };
}
