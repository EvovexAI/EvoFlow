import { getFiletypeFromFileName, getSingularPatch, parsePatchFiles } from "@pierre/diffs";

const MAX_PATCH_DIFF_SAFE_LINE_COUNT = 1_200;
const MAX_PATCH_DIFF_SAFE_CHAR_COUNT = 180_000;
const MAX_PATCH_DIFF_SAFE_HUNK_LINE_NUMBER = 1_200;
const MAX_PLAIN_TEXT_FALLBACK_RENDER_LINES = 800;
// 这里不能直接拼接展示文案，否则 lib 层会把英文硬编码带进 UI，破坏国际化。
// 改成内部 marker token，真正展示文案在组件层走 intl 渲染。
const FALLBACK_TRUNCATED_MARKER_PREFIX = "\\ __ZCODE_DIFF_TRUNCATED__:";
const FALLBACK_TRUNCATED_MARKER_REGEX = /^\\ __ZCODE_DIFF_TRUNCATED__:(\d+)$/;
const PACKAGE_MANAGER_LOCKFILE_NAMES = new Set([
  "bun.lock",
  "bun.lockb",
  "npm-shrinkwrap.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
]);
const PATCH_DIFF_FORCE_PLAIN_TEXT_FILE_TYPES = new Set(["zsh"]);
// Gradle 脚本会被 @pierre/diffs 识别成普通 text。
// 这类 patch 在部分入口或 worker 不可用时继续走 PatchDiff，仍可能同步解析卡住主线程。
// 这里按文件后缀提前降级成轻量 <pre>，避免点击文件 chip 后整屏不可交互。
const PATCH_DIFF_FORCE_PLAIN_TEXT_PATH_SUFFIXES = [".gradle", ".gradle.kts"];

function buildTruncatedMarkerLine(omittedLineCount: number): string {
  return `${FALLBACK_TRUNCATED_MARKER_PREFIX}${omittedLineCount}`;
}

export function countPatchFileDiffs(patch: string): number {
  const lines = patch.split(/\r?\n/);
  const gitDiffHeaderCount = lines.filter((line) => line.startsWith("diff --git ")).length;
  if (gitDiffHeaderCount > 0) {
    return gitDiffHeaderCount;
  }

  const parseHunkRange = (line: string): { oldLines: number; newLines: number } | null => {
    const match = line.match(/^@@\s-\d+(?:,(\d+))?\s\+\d+(?:,(\d+))?\s@@/);
    if (!match) {
      return null;
    }
    return {
      oldLines: Number(match[1] ?? "1"),
      newLines: Number(match[2] ?? "1"),
    };
  };

  const isFileHeaderPair = (index: number): boolean => {
    return (
      (lines[index]?.startsWith("--- ") ?? false) && (lines[index + 1]?.startsWith("+++ ") ?? false)
    );
  };

  const consumeHunkBody = (start: number, oldLines: number, newLines: number): number | null => {
    let cursor = start;
    let remainingOld = oldLines;
    let remainingNew = newLines;

    while (remainingOld > 0 || remainingNew > 0) {
      const line = lines[cursor];
      if (line === undefined) {
        return null;
      }

      // 没有 `diff --git` 前缀的多文件 patch 里，
      // 下一个文件头是 `--- a/x` 紧跟 `+++ b/x`。这两行恰好以 `-` / `+` 开头，
      // 把它们当成当前 hunk 的删除/新增行消费掉的话——当模型把 hunk 头的行数
      // 写得比正文多（LLM 常见的 off-by-one）时，多出的配额正好"吃掉"下一文件头，
      // 后续 `@@` 又被当成同一文件的下一个 hunk，导致多文件 patch 被误计为单文件。
      // 这里在消费正文时先探测完整的 `---`/`+++` 文件头对：一旦遇到就提前结束当前 hunk，
      // 把控制权交还外层循环去识别新文件，而不是把文件头并进正文。
      if (isFileHeaderPair(cursor)) {
        return cursor;
      }

      if (line.startsWith("\\ ")) {
        cursor += 1;
        continue;
      }

      if (line.startsWith(" ")) {
        remainingOld -= 1;
        remainingNew -= 1;
      } else if (line.startsWith("-")) {
        remainingOld -= 1;
      } else if (line.startsWith("+")) {
        remainingNew -= 1;
      } else {
        return null;
      }

      if (remainingOld < 0 || remainingNew < 0) {
        return null;
      }
      cursor += 1;
    }

    while (lines[cursor]?.startsWith("\\ ")) {
      cursor += 1;
    }
    return cursor;
  };

  let diffCount = 0;
  let cursor = 0;

  while (cursor < lines.length) {
    const oldHeader = lines[cursor];
    const newHeader = lines[cursor + 1];
    if (!oldHeader?.startsWith("--- ") || !newHeader?.startsWith("+++ ")) {
      cursor += 1;
      continue;
    }

    let hunkCursor = cursor + 2;
    let hasHunk = false;
    let sawHunkHeader = false;

    while (hunkCursor < lines.length) {
      const hunkRange = parseHunkRange(lines[hunkCursor] ?? "");
      if (!hunkRange) {
        break;
      }
      sawHunkHeader = true;

      const nextCursor = consumeHunkBody(hunkCursor + 1, hunkRange.oldLines, hunkRange.newLines);
      if (nextCursor === null) {
        break;
      }

      hasHunk = true;
      hunkCursor = nextCursor;
    }

    if (!hasHunk && !sawHunkHeader) {
      cursor += 1;
      continue;
    }

    // hunk 正文允许出现以 `---` / `+++` 开头的真实文本行，
    // 不能仅按 `---/+++` 生数；但当出现 hunk 头后正文被截断时，也应保守按“有一个文件 diff”计数。
    // 这里按 hunk 头声明的行数消费正文，只把成功解析出 hunk 的 `---/+++` 对识别成文件头，
    // 并在截断场景下保守计数，避免把多文件 patch 误判成单文件。
    diffCount += 1;
    cursor = hasHunk ? hunkCursor : cursor + 2;
  }

  return diffCount;
}

export function parseTruncatedMarkerOmittedLineCount(line: string): number | null {
  const markerMatch = FALLBACK_TRUNCATED_MARKER_REGEX.exec(line);
  if (!markerMatch) {
    return null;
  }

  const omittedLineCount = Number.parseInt(markerMatch[1] ?? "", 10);
  if (!Number.isFinite(omittedLineCount) || omittedLineCount <= 0) {
    return null;
  }

  return omittedLineCount;
}

export function getPatchPreviewLineContent(line: string): string {
  if (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) {
    return line.slice(1);
  }

  return line;
}

function isPatchHunkHeaderLine(line: string): boolean {
  return line === "@@" || line.startsWith("@@ ");
}

function getMaxHunkLineNumber(lines: readonly string[]): number {
  let maxLineNumber = 0;

  for (const line of lines) {
    if (!line.startsWith("@@ ")) {
      continue;
    }

    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!match) {
      continue;
    }

    const oldStart = Number.parseInt(match[1] ?? "0", 10);
    const oldCount = Number.parseInt(match[2] ?? "1", 10);
    const newStart = Number.parseInt(match[3] ?? "0", 10);
    const newCount = Number.parseInt(match[4] ?? "1", 10);
    const oldEnd = oldStart + Math.max(0, Number.isNaN(oldCount) ? 1 : oldCount) - 1;
    const newEnd = newStart + Math.max(0, Number.isNaN(newCount) ? 1 : newCount) - 1;

    maxLineNumber = Math.max(maxLineNumber, oldEnd, newEnd);
  }

  return maxLineNumber;
}

function limitPlainTextPreviewLines(lines: readonly string[]): string[] {
  if (lines.length <= MAX_PLAIN_TEXT_FALLBACK_RENDER_LINES) {
    return [...lines];
  }

  const keepCount = MAX_PLAIN_TEXT_FALLBACK_RENDER_LINES - 1;
  const headCount = Math.ceil(keepCount / 2);
  const tailCount = keepCount - headCount;
  const omittedCount = lines.length - keepCount;

  return [
    ...lines.slice(0, headCount),
    buildTruncatedMarkerLine(omittedCount),
    ...lines.slice(lines.length - tailCount),
  ];
}

function getPatchContentFileName(lines: readonly string[]): string | null {
  for (const line of lines) {
    if (!line.startsWith("--- ") && !line.startsWith("+++ ")) {
      continue;
    }

    // 标准 unified diff 头部允许在路径后追加 tab 分隔的时间戳。
    // 如果不先剥离时间戳，`.gradle` 这类按后缀降级的规则会被 `test.gradle\t...` 绕过。
    const fileName = line.slice(4).trim().split("\t", 1)[0]?.trim() ?? "";
    if (!fileName || fileName === "/dev/null") {
      continue;
    }

    return fileName;
  }

  return null;
}

function normalizePatchFileName(fileName: string): string {
  return fileName.replace(/^([ab])\//, "");
}

function isPackageManagerLockfile(fileName: string | null): boolean {
  if (!fileName) {
    return false;
  }

  return PACKAGE_MANAGER_LOCKFILE_NAMES.has(
    normalizePatchFileName(fileName).split("/").at(-1)?.toLocaleLowerCase() ?? "",
  );
}

function shouldForcePlainTextPatchPreviewByFileName(fileName: string | null): boolean {
  if (!fileName) {
    return false;
  }

  const normalizedFileName = normalizePatchFileName(fileName).toLocaleLowerCase();

  return PATCH_DIFF_FORCE_PLAIN_TEXT_PATH_SUFFIXES.some((suffix) =>
    normalizedFileName.endsWith(suffix),
  );
}

function shouldForcePlainTextPatchPreview(fileName: string | null): boolean {
  if (isPackageManagerLockfile(fileName)) {
    return true;
  }

  if (shouldForcePlainTextPatchPreviewByFileName(fileName)) {
    return true;
  }

  if (!fileName) {
    return false;
  }

  return PATCH_DIFF_FORCE_PLAIN_TEXT_FILE_TYPES.has(getFiletypeFromFileName(fileName));
}

function collectPatchMetadataPreviewLines(lines: readonly string[]): string[] {
  return lines.filter((line) => {
    const trimmedLine = line.trim();
    if (!trimmedLine) {
      return false;
    }

    return (
      !line.startsWith("diff --git ") &&
      !line.startsWith("index ") &&
      !line.startsWith("--- ") &&
      !line.startsWith("+++ ")
    );
  });
}

function collectPlainTextPreviewLines(lines: readonly string[]): string[] {
  const previewLines: string[] = [];
  let inHunk = false;

  for (const line of lines) {
    if (!inHunk) {
      if (isPatchHunkHeaderLine(line)) {
        inHunk = true;
      }
      continue;
    }

    // 之前直接按 `+++ / --- / @@` 前缀过滤，
    // 会把正文里真实存在的 `++ ` / `-- ` 行误删。
    // 这里改成只跳过 hunk 头本身；一旦进入 hunk，后续内容全部原样保留。
    if (isPatchHunkHeaderLine(line)) {
      continue;
    }

    previewLines.push(line);
  }

  if (inHunk || previewLines.length > 0) {
    return previewLines;
  }

  // rename-only / mode-only 这类 Git patch 没有 @@ hunk，
  // 但仍然有用户需要看的变更信息。之前会继续交给 PatchDiff，
  // 打包后部分文件展开会变成空白；这里保留元信息走轻量 fallback。
  return collectPatchMetadataPreviewLines(lines);
}

function normalizePlainTextPreviewLines(lines: readonly string[]): string[] {
  const normalizedLines = limitPlainTextPreviewLines(lines);

  // fallback 的目标是保住可读性和交互性，不需要继续暴露 `---/+++ / @@` 这些协议头。
  while (normalizedLines.length > 0 && normalizedLines.at(-1) === "") {
    normalizedLines.pop();
  }

  return normalizedLines.length > 0 ? normalizedLines : [""];
}

export function getPlainTextPatchPreviewLines(patch: string): string[] {
  return normalizePlainTextPreviewLines(getPlainTextPatchContentLines(patch));
}

export function getPlainTextPatchContentLines(patch: string): string[] {
  return collectPlainTextPreviewLines(patch.split(/\r?\n/));
}

export function getPlainTextPatchFallbackLines(patch: string): string[] | null {
  const lines = patch.split(/\r?\n/);
  const patchFileDiffCount = countPatchFileDiffs(patch);
  const hasMultipleFileDiffs = patchFileDiffCount > 1;
  const hasNoFileDiff = patchFileDiffCount === 0;
  const isCreatedFile = lines.some((line) => line === "--- /dev/null");
  const isDeletedFile = lines.some((line) => line === "+++ /dev/null");
  const maxHunkLineNumber = getMaxHunkLineNumber(lines);
  const isOversizedPatch =
    lines.length > MAX_PATCH_DIFF_SAFE_LINE_COUNT || patch.length > MAX_PATCH_DIFF_SAFE_CHAR_COUNT;
  const isDeepHunkLinePatch = maxHunkLineNumber > MAX_PATCH_DIFF_SAFE_HUNK_LINE_NUMBER;
  const patchFileName = getPatchContentFileName(lines);
  const shouldForcePlainTextPreview = shouldForcePlainTextPatchPreview(patchFileName);

  const metadataOnlyPreviewLines = collectPatchMetadataPreviewLines(lines);
  const isMetadataOnlyPatch =
    metadataOnlyPreviewLines.length > 0 && !lines.some(isPatchHunkHeaderLine);

  if (
    !hasNoFileDiff &&
    !hasMultipleFileDiffs &&
    !isCreatedFile &&
    !isDeletedFile &&
    !isOversizedPatch &&
    !isDeepHunkLinePatch &&
    !isMetadataOnlyPatch &&
    !shouldForcePlainTextPreview
  ) {
    try {
      // 自有计数器按 hunk 行数能判断这是逻辑上的单文件，但 PatchDiff 的实际解析器
      // 会把删除的 SQL 注释（patch 正文形如 `--- ...`）误切成第二个文件。最终是否安全必须以
      // 真正负责渲染的 @pierre/diffs 解析结果为准，不能让两套解析语义再次产生漏网输入。
      // 这里不能调用 getSingularPatch：它会在预期的多文件结果上先 console.error(files) 再抛错，
      // 把用户代码泄露到控制台。改用 throwOnError 解析并自行判断数量，让正常降级保持无日志副作用。
      const parsedPatches = parsePatchFiles(patch, undefined, true);
      if (parsedPatches.length === 1 && parsedPatches[0]?.files.length === 1) {
        return null;
      }
    } catch {
      // 解析失败与解析出多个文件都属于预期降级条件，统一在下方返回轻量文本预览。
    }
    return normalizePlainTextPreviewLines(collectPlainTextPreviewLines(lines));
  }

  if (isMetadataOnlyPatch) {
    return normalizePlainTextPreviewLines(metadataOnlyPreviewLines);
  }

  if (hasNoFileDiff) {
    // summary/工具回放里可能拿到 apply_patch 片段或裸 hunk。
    // 这些输入没有标准 file diff 头，PatchDiff 会同步抛
    // “Provided patch must contain exactly 1 file diff”，所以必须直接降级。
    return normalizePlainTextPreviewLines(collectPlainTextPreviewLines(lines));
  }

  if (shouldForcePlainTextPreview) {
    // lockfile / shell script 这类文件在生产包里走 PatchDiff 的高亮 worker 路径不稳定，
    // 已观察到 diff 已加载但展开内容失败。这里固定走轻量文本预览，优先保证内容可见。
    return normalizePlainTextPreviewLines(collectPlainTextPreviewLines(lines));
  }

  if ((isCreatedFile || isDeletedFile) && !isOversizedPatch && !isDeepHunkLinePatch) {
    // 文件变更面板展开“非纯文本”新增/删除文件时，PatchDiff 可能只渲染空壳，
    // 用户看到的是展开后没有任何内容。新增/删除文件本来就是整文件快照，
    // 这里不再按扩展名分流，统一走轻量文本 fallback，优先保证展开态始终有可读内容。
    return normalizePlainTextPreviewLines(collectPlainTextPreviewLines(lines));
  }

  if (!hasMultipleFileDiffs && !isOversizedPatch && !isDeepHunkLinePatch) {
    try {
      const resolvedPatchFileName = patchFileName ?? getSingularPatch(patch).name;
      const patchFileType = getFiletypeFromFileName(resolvedPatchFileName);

      // 新建/删除的纯文本文件即使 patch 很小，
      // `@pierre/diffs` 也可能在同步渲染阶段卡住主线程，表现成整个界面都点不动。
      // 另外删除文件里如果正文恰好以 `--- ` 开头，`getSingularPatch()` 会把它误拆成新的文件头。
      // 这里优先用首个真实文件头提取路径，再回退到库解析，避免文件类型判断被正文干扰。
      // 未知后缀会回退成 text，所以这里按解析后的文件类型拦截，而不是只匹配固定扩展名。
      if (patchFileType !== "text") {
        return null;
      }
    } catch {
      // 单文件数量检测只能过滤明显的畸形输入；真正交给 @pierre/diffs 前仍要尊重
      // 解析器结果。解析失败说明它无法确认“恰好一个 file diff”，继续渲染会触发错误边界。
      return normalizePlainTextPreviewLines(collectPlainTextPreviewLines(lines));
    }
  }

  // `@pierre/diffs` 的 PatchDiff 只能渲染单文件 patch。
  // 某些工具链会把多个文件的 unified diff 拼进同一个字段，继续交给 PatchDiff 会在渲染阶段抛
  // “Provided patch must contain exactly 1 file diff”，最终触发整页错误边界。
  // 这里和大文件/深行号一样降级为纯文本预览，保住聊天界面的可用性。
  // 超大 patch（例如千行级 Dockerfile）在展开时会触发 PatchDiff 的同步解析，
  // UI 主线程会被长时间占用，表现为点击“展开 diff”后整个页面卡死。
  // 另外某些大文件只改 1 行时，hunk 行号会落在很深的位置（如 1500+），
  // PatchDiff 在这类输入上也可能出现长时间卡顿。
  // 这里统一退化为轻量纯文本渲染，优先保证交互可用性。

  return normalizePlainTextPreviewLines(collectPlainTextPreviewLines(lines));
}
