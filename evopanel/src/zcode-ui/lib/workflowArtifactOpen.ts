/**
 * html 产物点击的落点判定。
 *
 * 一枚 html 产物药丸的意思是「让我看这个页面」，而不是「让我看这个页面的元数据卡，再从卡上
 * 点一次去看页面」。所以凡是**能**直接开内嵌浏览器的场合就直接开，产物 tab 退居兜底。
 * 判据与 `shouldOpenAssistantHtmlInBrowser`（lib/assistantPreviewCards.ts）同源：
 *
 * - `text/html` 严格相等，与 `WorkflowArtifactBody` 里画 html 卡的那道门同一个判据。
 *   宽到 `text/html; charset=utf-8` 会让「直开」和「卡片上有没有那颗按钮」两处判据分叉。
 * - 没有内嵌浏览器（Web / 手机远控）时 `handleOpenBrowserUrl` 只会 `window.open`，
 *   而 `file://` 在那儿打不开——只能退回产物 tab。
 * - 远程 workspace（SSH / WSL / Docker）与手机远控的 `sourcePath` 在本机不存在，同 `canRevealArtifactInWorkspace`。
 *
 * `contentType` 缺席（老 CLI、冷恢复、或表面本来就不带摘要）一律退回产物 tab：判不出来就
 * 走原路，绝不猜。
 */
export function shouldOpenWorkflowArtifactInBrowser(params: {
  contentType?: string;
  supportsEmbeddedBrowser: boolean;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}): boolean {
  return (
    params.contentType === "text/html" &&
    params.supportsEmbeddedBrowser &&
    !params.workspaceIdentity?.trim() &&
    !params.remoteSessionId
  );
}
