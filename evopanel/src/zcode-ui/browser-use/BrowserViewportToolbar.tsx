import { useEffect, useState, type KeyboardEvent } from "react";
import {
  BROWSER_VIEWPORT_LIMITS,
  TID_BROWSER_RESPONSIVE_HEIGHT_INPUT,
  TID_BROWSER_RESPONSIVE_TOOLBAR,
  TID_BROWSER_RESPONSIVE_WIDTH_INPUT,
  TID_BROWSER_RESPONSIVE_ZOOM_OPTION,
  TID_BROWSER_RESPONSIVE_ZOOM_SELECT,
  type BrowserViewportSize,
} from "@zcode/shared";
import {
  BROWSER_VIEWPORT_ZOOM_OPTIONS,
  type BrowserViewportZoom,
} from "@/browser-use/browserViewportZoom.js";
import { Input } from "@/components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

type ViewportDimension = "height" | "width";

function isValidViewportDimension(dimension: ViewportDimension, value: number): boolean {
  if (!Number.isInteger(value)) return false;
  if (dimension === "width") {
    return value >= BROWSER_VIEWPORT_LIMITS.minWidth && value <= BROWSER_VIEWPORT_LIMITS.maxWidth;
  }
  return value >= BROWSER_VIEWPORT_LIMITS.minHeight && value <= BROWSER_VIEWPORT_LIMITS.maxHeight;
}

function getViewportDimensionLimits(dimension: ViewportDimension): { max: number; min: number } {
  return dimension === "width"
    ? { max: BROWSER_VIEWPORT_LIMITS.maxWidth, min: BROWSER_VIEWPORT_LIMITS.minWidth }
    : { max: BROWSER_VIEWPORT_LIMITS.maxHeight, min: BROWSER_VIEWPORT_LIMITS.minHeight };
}

export function BrowserViewportToolbar({
  isVisible,
  onViewportSizeChange,
  onZoomChange,
  viewportSize,
  zoom,
}: {
  isVisible: boolean;
  onViewportSizeChange: (viewportSize: BrowserViewportSize) => void;
  onZoomChange: (zoom: BrowserViewportZoom) => void;
  viewportSize: BrowserViewportSize;
  zoom: BrowserViewportZoom;
}): React.JSX.Element {
  const { intl } = useZCodeIntl();
  const [widthDraft, setWidthDraft] = useState(String(viewportSize.width));
  const [heightDraft, setHeightDraft] = useState(String(viewportSize.height));
  const [invalidDrafts, setInvalidDrafts] = useState<Record<ViewportDimension, boolean>>({
    height: false,
    width: false,
  });

  useEffect(() => {
    setWidthDraft(String(viewportSize.width));
  }, [viewportSize.width]);

  useEffect(() => {
    setHeightDraft(String(viewportSize.height));
  }, [viewportSize.height]);

  const setDraftInvalid = (dimension: ViewportDimension, invalid: boolean) => {
    setInvalidDrafts((previous) =>
      previous[dimension] === invalid ? previous : { ...previous, [dimension]: invalid },
    );
  };

  const resetDraft = (dimension: ViewportDimension) => {
    setDraftInvalid(dimension, false);
    if (dimension === "width") {
      setWidthDraft(String(viewportSize.width));
      return;
    }
    setHeightDraft(String(viewportSize.height));
  };

  const commitDraft = (dimension: ViewportDimension) => {
    const draft = dimension === "width" ? widthDraft : heightDraft;
    const value = Number(draft.trim());
    if (!isValidViewportDimension(dimension, value)) {
      // 越界时直接恢复旧值会让用户无法判断是 Fit 回写还是输入超限。
      // 保留原始草稿并展示共享协议范围，让 UI 与 Agent viewport schema 的失败语义一致。
      setDraftInvalid(dimension, true);
      return;
    }
    setDraftInvalid(dimension, false);
    if (viewportSize[dimension] === value) {
      resetDraft(dimension);
      return;
    }
    onViewportSizeChange({ ...viewportSize, [dimension]: value });
  };

  const handleDraftChange = (dimension: ViewportDimension, value: string) => {
    if (dimension === "width") {
      setWidthDraft(value);
    } else {
      setHeightDraft(value);
    }
    if (invalidDrafts[dimension]) {
      setDraftInvalid(dimension, !isValidViewportDimension(dimension, Number(value.trim())));
    }
  };

  const getRangeError = (dimension: ViewportDimension) => {
    const limits = getViewportDimensionLimits(dimension);
    return intl.formatMessage(
      { id: "browser.responsive.dimensionRangeError" },
      { max: String(limits.max), min: String(limits.min) },
    );
  };

  const handleDimensionKeyDown = (
    dimension: ViewportDimension,
    event: KeyboardEvent<HTMLInputElement>,
  ) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commitDraft(dimension);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      resetDraft(dimension);
      event.currentTarget.blur();
    }
  };

  return (
    <div
      className="flex h-8 shrink-0 items-center justify-center gap-1 overflow-x-auto border-y border-border bg-background px-2"
      data-testid={TID_BROWSER_RESPONSIVE_TOOLBAR}
    >
      {/* TooltipContent 通过 Portal 挂到 body；不可见 tab 的触发器处于 display:none，
          仍保持 open 会让浮层拿到 0×0 锚点并泄漏到窗口左上角。只在当前视图可见时展示。 */}
      <Tooltip open={isVisible && invalidDrafts.width}>
        <TooltipTrigger asChild>
          <Input
            aria-invalid={invalidDrafts.width || undefined}
            aria-label={intl.formatMessage({ id: "browser.responsive.width" })}
            className="h-7 w-14 shrink-0 border-transparent bg-transparent px-1 text-center font-sans text-ui-base font-medium tabular-nums hover:border-transparent hover:bg-hover focus-visible:border-input-border-focused focus-visible:bg-input-focused aria-invalid:hover:border-destructive aria-invalid:focus-visible:border-destructive"
            data-testid={TID_BROWSER_RESPONSIVE_WIDTH_INPUT}
            inputMode="numeric"
            max={BROWSER_VIEWPORT_LIMITS.maxWidth}
            min={BROWSER_VIEWPORT_LIMITS.minWidth}
            onBlur={() => commitDraft("width")}
            onChange={(event) => handleDraftChange("width", event.target.value)}
            onKeyDown={(event) => handleDimensionKeyDown("width", event)}
            size="sm"
            spellCheck={false}
            value={widthDraft}
          />
        </TooltipTrigger>
        <TooltipContent
          align="center"
          className="border-destructive bg-popover text-destructive"
          side="bottom"
          sideOffset={4}
        >
          {getRangeError("width")}
        </TooltipContent>
      </Tooltip>
      {invalidDrafts.width ? (
        <span className="sr-only" role="alert">
          {getRangeError("width")}
        </span>
      ) : null}
      <span aria-hidden="true" className="shrink-0 text-ui-base text-foreground-subtle">
        ×
      </span>
      <Tooltip open={isVisible && invalidDrafts.height}>
        <TooltipTrigger asChild>
          <Input
            aria-invalid={invalidDrafts.height || undefined}
            aria-label={intl.formatMessage({ id: "browser.responsive.height" })}
            className="h-7 w-14 shrink-0 border-transparent bg-transparent px-1 text-center font-sans text-ui-base font-medium tabular-nums hover:border-transparent hover:bg-hover focus-visible:border-input-border-focused focus-visible:bg-input-focused aria-invalid:hover:border-destructive aria-invalid:focus-visible:border-destructive"
            data-testid={TID_BROWSER_RESPONSIVE_HEIGHT_INPUT}
            inputMode="numeric"
            max={BROWSER_VIEWPORT_LIMITS.maxHeight}
            min={BROWSER_VIEWPORT_LIMITS.minHeight}
            onBlur={() => commitDraft("height")}
            onChange={(event) => handleDraftChange("height", event.target.value)}
            onKeyDown={(event) => handleDimensionKeyDown("height", event)}
            size="sm"
            spellCheck={false}
            value={heightDraft}
          />
        </TooltipTrigger>
        <TooltipContent
          align="center"
          className="border-destructive bg-popover text-destructive"
          side="bottom"
          sideOffset={4}
        >
          {getRangeError("height")}
        </TooltipContent>
      </Tooltip>
      {invalidDrafts.height ? (
        <span className="sr-only" role="alert">
          {getRangeError("height")}
        </span>
      ) : null}
      <Select value={zoom} onValueChange={(value) => onZoomChange(value as BrowserViewportZoom)}>
        <SelectTrigger
          aria-label={intl.formatMessage({ id: "browser.responsive.zoom" })}
          className="min-w-24 shrink-0 font-medium tabular-nums"
          data-testid={TID_BROWSER_RESPONSIVE_ZOOM_SELECT}
          size="default"
          variant="ghost"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="end">
          {BROWSER_VIEWPORT_ZOOM_OPTIONS.map((option) => (
            <SelectItem
              data-testid={`${TID_BROWSER_RESPONSIVE_ZOOM_OPTION}-${option}`}
              key={option}
              value={option}
            >
              {option === "fit"
                ? intl.formatMessage({ id: "browser.responsive.fitToWindow" })
                : `${option}%`}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
