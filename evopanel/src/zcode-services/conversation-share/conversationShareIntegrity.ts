import { createHash } from "node:crypto";

import {
  conversationShareConfirmRequestSchema,
  type ConversationShareArtifactDescriptor,
  type ConversationShareConfirmRequest,
} from "@zcode/shared";

type ConversationShareConfirmRequestBase = Omit<ConversationShareConfirmRequest, "integrity"> & {
  artifacts: ConversationShareArtifactDescriptor[];
};

function assertValidUnicode(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new TypeError("Conversation share JSON contains invalid Unicode");
      }
      index += 1;
      continue;
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new TypeError("Conversation share JSON contains invalid Unicode");
    }
  }
}

function canonicalizeValue(value: unknown): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number": {
      if (!Number.isFinite(value)) {
        throw new TypeError("Conversation share JSON numbers must be finite");
      }
      return JSON.stringify(value);
    }
    case "string":
      assertValidUnicode(value);
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map((entry) => canonicalizeValue(entry)).join(",")}]`;
      }

      const record = value as Record<string, unknown>;
      const entries = Object.keys(record)
        .sort()
        .map((key) => {
          assertValidUnicode(key);
          const entry = record[key];
          if (entry === undefined) {
            throw new TypeError("Conversation share JSON cannot contain undefined values");
          }
          return `${JSON.stringify(key)}:${canonicalizeValue(entry)}`;
        });
      return `{${entries.join(",")}}`;
    }
    default:
      throw new TypeError(`Conversation share JSON cannot contain ${typeof value}`);
  }
}

function canonicalizeConversationShareJson(value: unknown): string {
  return canonicalizeValue(value);
}

export function sha256ConversationShareJson(value: unknown): string {
  return createHash("sha256")
    .update(canonicalizeConversationShareJson(value), "utf8")
    .digest("hex");
}

export function buildConversationShareConfirmRequest(
  input: ConversationShareConfirmRequestBase,
): ConversationShareConfirmRequest {
  const artifacts = [...input.artifacts].sort((left, right) =>
    left.artifact_id.localeCompare(right.artifact_id),
  );
  const projectionSha256 = sha256ConversationShareJson(input.projection.rows);
  const artifactSetSha256 = sha256ConversationShareJson(artifacts);
  const { artifacts: _artifacts, ...confirmRequest } = input;

  return conversationShareConfirmRequestSchema.parse({
    ...confirmRequest,
    integrity: {
      projection_sha256: projectionSha256,
      artifact_set_sha256: artifactSetSha256,
    },
  });
}

/**
 * 服务端签发 signed URL 时才有的字段，不参与 artifact set 摘要。
 *
 * 这是一份「服务端在读取时附加的字段」名单，不是「本端认识的字段」白名单——两者方向相反，
 * 选前者才对得上版本歪斜：
 * - 更新版发布端给 descriptor 加字段 → 它进了服务端存储、也进了服务端算的摘要，
 *   老导入端按原始值算同样包含它，哈希对得上（这正是要保住的方向）；
 * - 若改成按本端已知字段投影，那个新字段会被削掉，哈希立刻不一致。
 *
 * 代价是：服务端将来在读取响应里新增字段（而不是回显上传内容）必须同步加进这份名单，
 * 否则摘要会不一致。这属于服务端违反 revision 契约（continuation integrity 定义在
 * descriptor 集合上），且症状明确、修法就是往这里加一个键。
 */
const ARTIFACT_URL_KEYS = ["download_url", "download_url_expires_at", "url", "url_expires_at"];

function artifactIdOf(value: unknown): string {
  const id = (value as { artifact_id?: unknown } | null)?.artifact_id;
  return typeof id === "string" ? id : "";
}

function stripArtifactUrls(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const stripped: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  for (const key of ARTIFACT_URL_KEYS) delete stripped[key];
  return stripped;
}

/**
 * 用服务端**原样发来的** rows / artifacts 复核两个摘要。
 *
 * 关键点是「原始值」：以前这里拿的是 zod 解析产物，而 zod 默认剥掉未知字段，所以发布端
 * 只要给 row 加一个 optional 字段，老导入端重算的哈希就必然不一致，报出「分享文件校验
 * 失败」——一条看着像被篡改的告警，加一个永远不会成功的重试按钮。
 *
 * 校验对原始字节之后，完整性与 schema 认知彻底解耦：schema 可以自由 additive 演进，而
 * 哈希不一致重新变成它本该表达的意思——内容真的被改过或损坏了。
 */
export function verifyConversationShareIntegrity(input: {
  rawRows: unknown;
  rawArtifacts: unknown;
  integrity: { projection_sha256: string; artifact_set_sha256: string };
}): boolean {
  const artifacts = Array.isArray(input.rawArtifacts)
    ? [...(input.rawArtifacts as unknown[])]
        .sort((left, right) => artifactIdOf(left).localeCompare(artifactIdOf(right)))
        .map(stripArtifactUrls)
    : input.rawArtifacts;
  return (
    sha256ConversationShareJson(input.rawRows) === input.integrity.projection_sha256 &&
    sha256ConversationShareJson(artifacts) === input.integrity.artifact_set_sha256
  );
}
