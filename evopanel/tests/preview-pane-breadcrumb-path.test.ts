import { describe, expect, it } from "vitest";
import { resolveCodeViewerBreadcrumbFolderPath } from "../src/zcode-ui/previewPaneBreadcrumb.ts";

describe("resolveCodeViewerBreadcrumbFolderPath", () => {
  const workspacePath =
    "D:/dev/github/knowledge-library/ai-showcase/ai-creative-ad-video";
  const sourcePath = `${workspacePath}/projects/火锅15s-20261124/打码版10张-第2段15秒-豆包直接粘.txt`;

  it("maps root crumb to workspace root", () => {
    expect(
      resolveCodeViewerBreadcrumbFolderPath({
        sourcePath,
        workspacePath,
        target: "root",
      }),
    ).toBe(workspacePath);
  });

  it("maps parent crumbs to nested folders under workspace", () => {
    expect(
      resolveCodeViewerBreadcrumbFolderPath({
        sourcePath,
        workspacePath,
        target: 0,
      }),
    ).toBe(`${workspacePath}/projects`);
    expect(
      resolveCodeViewerBreadcrumbFolderPath({
        sourcePath,
        workspacePath,
        target: 1,
      }),
    ).toBe(`${workspacePath}/projects/火锅15s-20261124`);
  });

  it("returns null past the last parent segment", () => {
    expect(
      resolveCodeViewerBreadcrumbFolderPath({
        sourcePath,
        workspacePath,
        target: 2,
      }),
    ).toBeNull();
  });
});
