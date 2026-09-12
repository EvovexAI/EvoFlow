/**
 * Remove private resume routes/content from a public-repo mirror tree.
 * Run from repo root: node website/scripts/strip-resume-for-public.mjs [targetDir]
 */
import fs from "node:fs";
import path from "node:path";

const target = path.resolve(process.argv[2] ?? process.cwd());

const removePaths = [
  "website/apps/web/src/app/r",
  "website/apps/web/src/app/resume",
  "website/apps/web/src/app/(marketing)/resume",
  "website/apps/web/src/components/resume",
  "website/apps/web/src/lib/resume-access.ts",
  "website/apps/web/src/lib/resume-export.ts",
  "website/apps/web/src/lib/resume-print-html.ts",
  "website/packages/content/src/resume.ts",
  "website/packages/content/src/resume-evoflow-layers.ts",
  "website/packages/content/src/resume-evoflow-plan.ts",
  "website/packages/content/src/resume-markdown.ts",
];

function rm(rel) {
  const full = path.join(target, rel);
  if (!fs.existsSync(full)) return;
  fs.rmSync(full, { recursive: true, force: true });
  console.log(`[strip-resume] removed ${rel}`);
}

for (const rel of removePaths) {
  rm(rel);
}

const indexPath = path.join(target, "website/packages/content/src/index.ts");
if (fs.existsSync(indexPath)) {
  const lines = fs.readFileSync(indexPath, "utf8").split("\n");
  const filtered = lines.filter(
    (line) => !line.includes("./resume") && !line.includes("resume-markdown"),
  );
  fs.writeFileSync(indexPath, `${filtered.join("\n").trimEnd()}\n`);
  console.log("[strip-resume] patched packages/content/src/index.ts");
}
