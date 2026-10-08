import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ChevronRightIcon } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { ProviderModelDraftCommitResult } from "@/settings/model-provider-section/ProviderModelMetadata.js";

type ErrorField = Extract<ProviderModelDraftCommitResult, { status: "invalid" }>["field"];
const ERROR_TARGETS: Partial<Record<ErrorField, string>> = {
  maxOutputTokens: "[data-model-max-output] input",
  reasoningLevelValues: "[data-model-reasoning-level-editor] :is(input, button)",
  reasoningLevelMap: "[data-model-json-slot] textarea",
  inputFormat: '[data-model-input-modality="image"]',
};

export function ModelEditorAdvanced({
  open,
  errorField,
  validationAttempt,
  children,
}: {
  open: boolean;
  errorField?: ErrorField | null;
  validationAttempt: number;
  children: ReactNode;
}) {
  const { intl } = useZCodeIntl();
  const ref = useRef<HTMLDivElement>(null);
  const contentId = useId();
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (!open) {
      setExpanded(false);
      return;
    }
    // 错误位置随布局变化：最大输出已在基础区；推理等级和映射必须展开才能修正。
    if (errorField && errorField !== "maxOutputTokens" && ERROR_TARGETS[errorField]) {
      setExpanded(true);
    }
  }, [open, errorField, validationAttempt]);
  useEffect(() => {
    const selector = errorField && ERROR_TARGETS[errorField];
    if (!open || !selector || (errorField !== "maxOutputTokens" && !expanded)) return;
    const target = ref.current
      ?.closest("[data-model-settings-scroll]")
      ?.querySelector<HTMLElement>(selector);
    let cancelled = false;
    // 等实际展开动画结束再聚焦，避免滚动到尚被裁切的输入；不依赖猜测的延时。
    const animations = ref.current?.getAnimations({ subtree: true }) ?? [];
    void Promise.all(animations.map((animation) => animation.finished.catch(() => {}))).then(() => {
      if (!cancelled) target?.focus();
    });
    return () => {
      cancelled = true;
    };
  }, [open, expanded, errorField, validationAttempt]);
  return (
    <div ref={ref} data-model-advanced="true">
      <button
        type="button"
        data-model-advanced-trigger="true"
        aria-expanded={expanded}
        aria-controls={contentId}
        onClick={() => setExpanded((value) => !value)}
        className="flex w-fit cursor-pointer items-center gap-2 rounded-sm bg-transparent px-2 py-1 text-ui-base text-foreground hover:bg-hover focus-visible:outline-2 focus-visible:outline-primary"
      >
        <ChevronRightIcon
          className={`size-4 transition-transform motion-reduce:transition-none ${expanded ? "rotate-90" : ""}`}
          aria-hidden="true"
        />
        {intl.formatMessage({ id: "settings.modelProvider.advancedConfig" })}
      </button>
      {/* 保持控件挂载，保留推理等级编辑器的局部草稿；收起时退出键盘及读屏导航。 */}
      <div
        id={contentId}
        inert={!expanded}
        aria-hidden={!expanded}
        className={`-mx-1 grid transition-[grid-template-rows,opacity,visibility] duration-200 motion-reduce:transition-none ${expanded ? "visible grid-rows-[1fr] opacity-100" : "invisible grid-rows-[0fr] opacity-0"}`}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="space-y-4 px-1 pt-4 pb-1">{children}</div>
        </div>
      </div>
    </div>
  );
}
