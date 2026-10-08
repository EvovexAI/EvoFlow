import type { CodeViewerSource } from "@/lib/codeViewer.js";
import { decodeFilePathUriEscapes, getPathLeaf } from "@/lib/path.js";

export function normalizeCodeViewerSource(source: CodeViewerSource): CodeViewerSource {
  const decodedTitle = decodeFilePathUriEscapes(source.title);

  if (!("path" in source) || !source.path) {
    return decodedTitle === source.title ? source : { ...source, title: decodedTitle };
  }

  const decodedPath = decodeFilePathUriEscapes(source.path);
  const sourceLeaf = getPathLeaf(source.path);
  const decodedLeaf = getPathLeaf(decodedPath);
  const title =
    source.title === sourceLeaf || source.title.trim().length === 0 ? decodedLeaf : decodedTitle;

  if (decodedPath === source.path && title === source.title) {
    return source;
  }

  return {
    ...source,
    title,
    path: decodedPath,
  };
}
