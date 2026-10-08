import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { FeedbackListQuery, FeedbackTicketStatus, FeedbackTicketSummary } from "@zcode/shared";
import { getFeedbackRootDir } from "#src/paths.js";

interface StoredFeedbackTicket extends FeedbackTicketSummary {
  deviceMid: string;
}

interface FeedbackTicketStoreFile {
  tickets: StoredFeedbackTicket[];
}

export class FeedbackLocalTicketStore {
  private readonly filePath: string;

  constructor(rootDir = getFeedbackRootDir()) {
    this.filePath = join(rootDir, "tickets.json");
  }

  async list(deviceMid: string, query: FeedbackListQuery = {}): Promise<FeedbackTicketSummary[]> {
    const tickets = (await this.read()).tickets
      .filter((ticket) => ticket.deviceMid === deviceMid)
      .filter((ticket) => {
        if (query.status && ticket.status !== query.status) return false;
        if (query.type && ticket.type !== query.type) return false;
        return true;
      })
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at));
    const offset = Math.max(0, query.offset ?? 0);
    const limit = query.limit !== undefined && query.limit >= 0 ? query.limit : tickets.length;
    return tickets
      .slice(offset, offset + limit)
      .map(({ deviceMid: _deviceMid, ...ticket }) => ticket);
  }

  async upsert(deviceMid: string, ticket: FeedbackTicketSummary): Promise<void> {
    const file = await this.read();
    const next: StoredFeedbackTicket = { ...ticket, deviceMid };
    const rest = file.tickets.filter(
      (current) => current.deviceMid !== deviceMid || current.id !== ticket.id,
    );
    await this.write({ tickets: [next, ...rest].slice(0, 200) });
  }

  private async read(): Promise<FeedbackTicketStoreFile> {
    try {
      const text = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(text) as unknown;
      if (!isObjectRecord(parsed) || !Array.isArray(parsed.tickets)) {
        return { tickets: [] };
      }
      return {
        tickets: parsed.tickets.filter(isStoredFeedbackTicket).map(migrateStoredFeedbackTicket),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { tickets: [] };
      }
      return { tickets: [] };
    }
  }

  private async write(file: FeedbackTicketStoreFile): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  }
}

function migrateStoredFeedbackTicket(ticket: StoredFeedbackTicket): StoredFeedbackTicket {
  // 3.3.5 将「待评估」重命名为「已提交」，旧版匿名反馈仍会把旧值留在 tickets.json；
  // 读取时不迁移或放行未知值会让状态元数据查找返回 undefined，点击「我的反馈」后渲染崩溃。
  const status = String(ticket.status);
  if (status === "待评估" || !isFeedbackTicketStatus(status)) {
    return { ...ticket, status: "已提交" };
  }
  return ticket;
}

function isFeedbackTicketStatus(status: string): status is FeedbackTicketStatus {
  switch (status) {
    case "已提交":
    case "信息不足":
    case "已采纳":
    case "答复关闭":
    case "已归档":
    case "已拒绝":
    case "开发中":
    case "已解决":
    case "已上线":
      return true;
    default:
      return false;
  }
}

function isStoredFeedbackTicket(value: unknown): value is StoredFeedbackTicket {
  if (!isObjectRecord(value)) {
    return false;
  }
  return (
    typeof value.deviceMid === "string" &&
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    typeof value.type === "string" &&
    typeof value.status === "string" &&
    typeof value.created_at === "string" &&
    typeof value.updated_at === "string"
  );
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
