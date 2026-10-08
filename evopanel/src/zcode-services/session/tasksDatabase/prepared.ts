import type { DatabaseSync } from "node:sqlite";
import { areTasksDatabaseMigrationsApplied } from "#src/session/tasksDatabase/migrations.js";
// 仅当前进程的启动交接凭据；不落盘、不代替 SQLite 账本，不影响不同路径的新库。
const migrated = new Set<string>();
const prepared = new Set<string>();
export function markTasksStorageMigrated(path: string): void {
  migrated.add(path);
}
export function markTasksStoragePrepared(path: string): void {
  migrated.add(path);
  prepared.add(path);
}
export function isTasksStorageMigrated(path: string, db: DatabaseSync): boolean {
  return migrated.has(path) && areTasksDatabaseMigrationsApplied(db);
}
export function isTasksStoragePrepared(path: string, db: DatabaseSync): boolean {
  return prepared.has(path) && areTasksDatabaseMigrationsApplied(db);
}
