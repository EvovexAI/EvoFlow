import { ImageIcon } from "lucide-react";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { CuaScreenshotDetails } from "@/ToolCallBlocks/renderers/cuaScreenshotDetails.js";

export function CuaScreenshotSection({ screenshot }: { screenshot: CuaScreenshotDetails }) {
  const { intl } = useZCodeIntl();
  const metadata: Array<[string, string]> = [];
  const titleId = screenshot.zoom
    ? "chat.toolCall.cua.details.zoomPreview"
    : "chat.toolCall.cua.details.screenshot";
  if (screenshot.fullScreen)
    metadata.push([
      "chat.toolCall.cua.details.scope",
      intl.formatMessage({ id: "chat.toolCall.cua.details.fullScreen" }),
    ]);
  if (screenshot.region) metadata.push(["chat.toolCall.cua.details.region", screenshot.region]);
  if (screenshot.width && screenshot.height)
    metadata.push([
      "chat.toolCall.cua.details.dimensions",
      `${screenshot.width} × ${screenshot.height}`,
    ]);
  if (screenshot.mimeType)
    metadata.push([
      "chat.toolCall.cua.details.format",
      screenshot.mimeType.replace(/^image\//u, "").toUpperCase(),
    ]);
  if (screenshot.clamped)
    metadata.push([
      "chat.toolCall.cua.details.bounds",
      intl.formatMessage({ id: "chat.toolCall.cua.details.clamped" }),
    ]);

  return (
    <section className="space-y-2 border-t border-border pt-3">
      <h4 className="text-sm text-foreground-subtle">{intl.formatMessage({ id: titleId })}</h4>
      {screenshot.dataUrl ? (
        <Dialog>
          <DialogTrigger asChild>
            <button
              type="button"
              className="block w-full overflow-hidden rounded-lg border border-border bg-surface outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <img
                src={screenshot.dataUrl}
                alt={intl.formatMessage({ id: "chat.toolCall.cua.details.openScreenshot" })}
                className="max-h-96 w-full object-contain"
              />
            </button>
          </DialogTrigger>
          <DialogContent className="rounded-xl max-h-[calc(100vh-2rem)] max-w-[calc(100vw-2rem)] overflow-auto p-3">
            <DialogTitle className="sr-only">{intl.formatMessage({ id: titleId })}</DialogTitle>
            <img
              src={screenshot.dataUrl}
              alt=""
              className="max-h-[calc(100vh-4rem)] w-full object-contain"
            />
          </DialogContent>
        </Dialog>
      ) : (
        <div className="flex min-h-28 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-surface px-3 py-6 text-sm text-foreground-subtle">
          <ImageIcon className="size-5 text-foreground-subtlest" />
          <span>
            {intl.formatMessage({
              id: screenshot.zoom
                ? "chat.toolCall.cua.details.zoomUnavailable"
                : "chat.toolCall.cua.details.screenshotUnavailable",
            })}
          </span>
        </div>
      )}
      {metadata.length ? (
        <dl className="grid grid-cols-[minmax(4rem,auto)_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm">
          {metadata.map(([labelId, value]) => (
            <div key={labelId} className="contents">
              <dt className="text-foreground-subtlest">{intl.formatMessage({ id: labelId })}</dt>
              <dd className="text-foreground">{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </section>
  );
}
