/**
 * One-shot helper: patch an extracted @pierre/diffs tree for macOS 12 JSC
 * (no lookbehind). Used to generate patches/@pierre__diffs@1.1.22.patch.
 */
import fs from 'node:fs'
import path from 'node:path'

const root = process.argv[2]
if (!root) {
  console.error('usage: node _patch-pierre-diffs-macos12.mjs <package-root>')
  process.exit(1)
}

const CONSTANTS_OLD = 'const SPLIT_WITH_NEWLINES = /(?<=\\n)/;'
const CONSTANTS_NEW = `// COMPAT(macOS12-JSC): was /(?<=\\n)/. Lookbehind is unsupported on macOS 12's
// JavaScriptCore (< Safari 16.4); esbuild does not transpile regexes.
const SPLIT_WITH_NEWLINES = (() => {
	try {
		return new RegExp("(?<=\\\\n)");
	} catch {
		return null;
	}
})();`

const SPLIT_OLD = `function splitFileContents(contents) {
	return contents !== "" ? contents.split(SPLIT_WITH_NEWLINES) : [];
}`

const SPLIT_NEW = `function splitFileContents(contents) {
	if (contents === "") return [];
	if (SPLIT_WITH_NEWLINES != null) return contents.split(SPLIT_WITH_NEWLINES);
	// Keeps trailing newlines on each line - same as split(/(?<=\\n)/).
	const lines = [];
	let lineStart = 0;
	for (let i = 0; i < contents.length; i++) {
		if (contents.charCodeAt(i) === 10 /* \\n */) {
			lines.push(contents.slice(lineStart, i + 1));
			lineStart = i + 1;
		}
	}
	if (lineStart < contents.length) lines.push(contents.slice(lineStart));
	return lines;
}`

function mustReplace(file, oldText, newText) {
  const s = fs.readFileSync(file, 'utf8')
  if (!s.includes(oldText)) {
    throw new Error(`pattern missing in ${file}`)
  }
  fs.writeFileSync(file, s.replace(oldText, newText))
}

function patchParse(file) {
  let s = fs.readFileSync(file, 'utf8')
  if (!s.includes('splitFileContents.js')) {
    s = s.replace(
      'import { parseLineType } from "./parseLineType.js";',
      'import { parseLineType } from "./parseLineType.js";\nimport { splitFileContents } from "./splitFileContents.js";',
    )
  }
  s = s.replaceAll('hunk.split(SPLIT_WITH_NEWLINES)', 'splitFileContents(hunk)')
  s = s.replaceAll(
    'newFile.contents.split(SPLIT_WITH_NEWLINES)',
    'splitFileContents(newFile.contents)',
  )
  s = s.replaceAll(
    'oldFile.contents.split(SPLIT_WITH_NEWLINES)',
    'splitFileContents(oldFile.contents)',
  )
  if (!s.includes('SPLIT_WITH_NEWLINES')) {
    s = s.replace(', SPLIT_WITH_NEWLINES', '').replace('SPLIT_WITH_NEWLINES, ', '')
  }
  fs.writeFileSync(file, s)
}

function patchWorkerSplitUsages(file) {
  let s = fs.readFileSync(file, 'utf8')
  // Bundled workers inline parsePatchFiles — replace direct splits if present.
  const before = s
  s = s.replaceAll('hunk.split(SPLIT_WITH_NEWLINES)', 'splitFileContents(hunk)')
  s = s.replaceAll(
    'newFile.contents.split(SPLIT_WITH_NEWLINES)',
    'splitFileContents(newFile.contents)',
  )
  s = s.replaceAll(
    'oldFile.contents.split(SPLIT_WITH_NEWLINES)',
    'splitFileContents(oldFile.contents)',
  )
  if (s !== before) fs.writeFileSync(file, s)
}

mustReplace(path.join(root, 'dist/constants.js'), CONSTANTS_OLD, CONSTANTS_NEW)
mustReplace(path.join(root, 'dist/utils/splitFileContents.js'), SPLIT_OLD, SPLIT_NEW)
patchParse(path.join(root, 'dist/utils/parsePatchFiles.js'))

for (const rel of ['dist/worker/worker.js', 'dist/worker/worker-portable.js']) {
  const file = path.join(root, rel)
  mustReplace(file, CONSTANTS_OLD, CONSTANTS_NEW)
  mustReplace(file, SPLIT_OLD, SPLIT_NEW)
  patchWorkerSplitUsages(file)
}

console.log('patched', root)
