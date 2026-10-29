import { useMemo } from "react";
import { prepareHtmlSrcDocForPreview } from "@/lib/htmlPreview.js";

interface HtmlPreviewContentProps {
  title: string;
  htmlContent: string;
}

/** Sandboxed iframe preview for workspace HTML files. */
export function HtmlPreviewContent({ title, htmlContent }: HtmlPreviewContentProps) {
  const srcDoc = useMemo(() => prepareHtmlSrcDocForPreview(htmlContent), [htmlContent]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <iframe
        className="h-full w-full flex-1 border-0 bg-white"
        title={title}
        sandbox="allow-scripts allow-same-origin allow-forms allow-modals"
        srcDoc={srcDoc}
      />
    </div>
  );
}
