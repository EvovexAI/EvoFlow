import type { ReactNode } from "react";
import { Keyboard, Search, X } from "lucide-react";
import { Input } from "@/components/ui/input.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatShortcutBindingLabel } from "@/shortcuts/label.js";
import type { ShortcutKeySearch } from "./useShortcutKeySearch.js";

interface ShortcutSearchBarProps {
  query: string;
  onQueryChange: (value: string) => void;
  keySearch: ShortcutKeySearch;
  /** 武装态与行内录制互斥：激活按键搜索前先取消进行中的行内录制。 */
  onArmKeySearch: () => void;
  /** 搜索条右侧操作区（「全部恢复默认」按钮）。 */
  actions?: ReactNode;
}

/** 快捷键设置页搜索条：文本搜索框 + VSCode 式「按组合键搜索」按钮。 */
export function ShortcutSearchBar({
  query,
  onQueryChange,
  keySearch,
  onArmKeySearch,
  actions,
}: ShortcutSearchBarProps) {
  const { intl } = useZCodeIntl();
  // VSCode 同款展示：捕获的组合键作为输入框文本从左侧显示（替代文本搜索词，
  // 文本过滤条件仍在内部生效，× 清除后回到纯文本搜索）。
  const keyLabel =
    keySearch.binding !== null ? formatShortcutBindingLabel(keySearch.binding) : null;

  return (
    <div className="flex gap-2">
      <div className="relative flex-1">
        <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-foreground-subtle" />
        <Input
          className={`pl-9 font-mono ${keyLabel !== null ? "pr-16 text-brand" : "pr-9"}`}
          placeholder={
            keySearch.armed
              ? intl.formatMessage({ id: "settings.shortcuts.keySearchPlaceholder" })
              : intl.formatMessage({ id: "settings.shortcuts.searchPlaceholder" })
          }
          value={keyLabel ?? query}
          onChange={(e) => onQueryChange(e.target.value)}
          // 武装态键盘事件被 window capture 独占；捕获后展示的是组合 label 而非可编辑文本，
          // 两者都 readOnly，防止 IME/焦点残留造成的视觉歧义
          readOnly={keySearch.armed || keyLabel !== null}
          data-testid="settings-shortcut-search-input"
        />
        {keyLabel !== null ? (
          <button
            type="button"
            aria-label={intl.formatMessage({ id: "settings.shortcuts.keySearchClearAria" })}
            data-testid="settings-shortcut-key-search-clear"
            className="absolute right-9 top-1/2 -translate-y-1/2 rounded-sm p-0.5 text-foreground-subtle hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2"
            onClick={keySearch.clear}
          >
            <X className="size-3.5" />
          </button>
        ) : null}
        <button
          type="button"
          aria-label={intl.formatMessage({ id: "settings.shortcuts.keySearchAria" })}
          aria-pressed={keySearch.armed}
          data-testid="settings-shortcut-key-search"
          className={`absolute right-2.5 top-1/2 -translate-y-1/2 rounded-sm p-1 focus-visible:outline-2 focus-visible:outline-offset-2 ${
            keySearch.armed ? "text-brand" : "text-foreground-subtle hover:text-foreground"
          }`}
          onClick={() => {
            if (!keySearch.armed) {
              onArmKeySearch();
            }
            keySearch.toggle();
          }}
        >
          <Keyboard className="size-4" />
        </button>
      </div>
      {actions}
    </div>
  );
}
