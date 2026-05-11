import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function getWorkspaceRoot() {
  let currentDirectory = path.dirname(fileURLToPath(import.meta.url));

  while (true) {
    const workspaceMarker = path.join(currentDirectory, "pnpm-workspace.yaml");
    const memoryMarker = path.join(currentDirectory, "MEMORY.md");

    if (fs.existsSync(workspaceMarker) || fs.existsSync(memoryMarker)) {
      return currentDirectory;
    }

    const parentDirectory = path.dirname(currentDirectory);

    if (parentDirectory === currentDirectory) {
      return process.cwd();
    }

    currentDirectory = parentDirectory;
  }
}

const runtimeRoot = path.join(getWorkspaceRoot(), ".runtime");

export function ensureRuntimeDirectory() {
  fs.mkdirSync(runtimeRoot, { recursive: true });
  return runtimeRoot;
}

export function resolveRuntimeFilePath(filename: string) {
  ensureRuntimeDirectory();
  return path.join(runtimeRoot, path.basename(filename));
}
