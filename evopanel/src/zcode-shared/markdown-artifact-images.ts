const ARTIFACT_IMAGE_RENDER_PREFIX = "/__zcode_artifact_image__/";
const FENCE_PATTERN = /^( {0,3})(`{3,}|~{3,})(.*)$/u;
const ARTIFACT_IMAGE_PATTERN =
  /!\[[^\]\n]*\]\(\s*(?:<)?(zcode-artifact:\/\/[^\s)>]+)(?:>)?(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/gu;

function mapOutsideMarkdownFences(markdown: string, transform: (line: string) => string): string {
  let activeMarker: "`" | "~" | null = null;
  let activeLength = 0;
  return markdown
    .split("\n")
    .map((line) => {
      const fence = line.match(FENCE_PATTERN);
      if (fence?.[2]) {
        const run = fence[2];
        const marker = run[0] as "`" | "~";
        const suffix = fence[3] ?? "";
        if (activeMarker === marker && run.length >= activeLength && suffix.trim() === "") {
          activeMarker = null;
          activeLength = 0;
        } else if (!activeMarker && (marker === "~" || !suffix.includes("`"))) {
          activeMarker = marker;
          activeLength = run.length;
        }
        return line;
      }
      return activeMarker ? line : transform(line);
    })
    .join("\n");
}

export function extractMarkdownArtifactImageRefs(markdown: string): string[] {
  const refs = new Set<string>();
  mapOutsideMarkdownFences(markdown, (line) => {
    for (const match of line.matchAll(ARTIFACT_IMAGE_PATTERN)) {
      if (match[1]) refs.add(match[1]);
    }
    return line;
  });
  return [...refs];
}

export function rewriteMarkdownArtifactImageSources(markdown: string): string {
  return mapOutsideMarkdownFences(markdown, (line) =>
    line.replace(ARTIFACT_IMAGE_PATTERN, (image, ref: string) =>
      image.replace(ref, `${ARTIFACT_IMAGE_RENDER_PREFIX}${encodeURIComponent(ref)}`),
    ),
  );
}

export function decodeMarkdownArtifactImageSource(source: string): string | null {
  if (!source.startsWith(ARTIFACT_IMAGE_RENDER_PREFIX)) return null;
  try {
    const ref = decodeURIComponent(source.slice(ARTIFACT_IMAGE_RENDER_PREFIX.length));
    return ref.startsWith("zcode-artifact://") ? ref : null;
  } catch {
    return null;
  }
}
