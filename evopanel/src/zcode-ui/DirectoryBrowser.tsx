import { useEffect, useState, useRef } from "react";
import type { IServiceAccessor } from "@zcode/services";
import type { FileEntry } from "@zcode/shared";
import { FolderIcon, FolderSymlinkIcon } from "lucide-react";
import { Button } from "./components/ui/button.js";
import { Input } from "./components/ui/input.js";
import { useZCodeIntl } from "./i18n/IntlProvider.js";
import { logger } from "./logger.js";

function createDirectoryBrowserReadParams(
  path: string,
  showHiddenDirectories: boolean,
): { path: string; includeHidden?: boolean } {
  return showHiddenDirectories ? { path, includeHidden: true } : { path };
}

function filterDirectoryBrowserEntries(entries: FileEntry[]): FileEntry[] {
  return entries.filter((e) => e.type === "directory");
}

// 远程目录条目已经携带 isSymbolicLink，这里只替换展示图标，不改变进入和选择目录的路径语义。
function getDirectoryBrowserEntryIconKind(
  entry: Pick<FileEntry, "isSymbolicLink" | "type">,
): "folder" | "folder-symlink" {
  return entry.type === "directory" && entry.isSymbolicLink === true ? "folder-symlink" : "folder";
}

function createDirectoryBrowserRequestGuard(): {
  begin: () => number;
  isCurrent: (requestId: number) => boolean;
} {
  let latestRequestId = 0;

  return {
    begin: () => {
      latestRequestId += 1;
      return latestRequestId;
    },
    isCurrent: (requestId: number) => requestId === latestRequestId,
  };
}

/**
 * 服务端目录浏览对话框。
 * 通过 fileService.readdir 浏览远程/本地服务器的目录结构，
 * 适用于 web 端无法调用系统原生文件选择器的场景。
 */
export function DirectoryBrowser({
  services,
  onSelect,
  onCancel,
  onPathChange,
  embedded = false,
}: {
  services: IServiceAccessor;
  onSelect: (path: string) => void;
  onCancel: () => void;
  onPathChange?: (path: string) => void;
  embedded?: boolean;
}) {
  const [currentPath, setCurrentPath] = useState("");
  const [inputPath, setInputPath] = useState("");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showHiddenDirectories, setShowHiddenDirectories] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const showHiddenDirectoriesRef = useRef(false);
  const requestGuardRef = useRef(createDirectoryBrowserRequestGuard());
  const { intl } = useZCodeIntl();

  // 初始化：获取 homedir 作为起始路径
  useEffect(() => {
    services.systemService
      .info()
      .then((info) => {
        navigateTo(info.homedir);
      })
      .catch((err) => {
        logger.error("[DirectoryBrowser] 获取系统信息失败:", err);
        setError(intl.formatMessage({ id: "directoryBrowser.errorSystem" }));
        setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const navigateTo = async (
    path: string,
    nextShowHiddenDirectories = showHiddenDirectoriesRef.current,
  ) => {
    const requestId = requestGuardRef.current.begin();
    setLoading(true);
    setError("");
    try {
      const result = await services.fileService.readdir(
        createDirectoryBrowserReadParams(path, nextShowHiddenDirectories),
      );
      if (!requestGuardRef.current.isCurrent(requestId)) {
        return;
      }
      const dirs = filterDirectoryBrowserEntries(result);
      setEntries(dirs);
      setCurrentPath(path);
      setInputPath(path);
      onPathChange?.(path);
      // 滚动到顶部
      listRef.current?.scrollTo(0, 0);
    } catch (err) {
      if (!requestGuardRef.current.isCurrent(requestId)) {
        return;
      }
      // 用户快速切换目录或隐藏目录时，较早 readdir 可能后返回；
      // 过期错误不能覆盖最新导航状态，否则 UI 会展示和当前按钮状态不一致的目录/错误。
      logger.error("[DirectoryBrowser] readdir 失败:", err);
      setError(intl.formatMessage({ id: "directoryBrowser.errorReadDir" }, { error: String(err) }));
    } finally {
      if (requestGuardRef.current.isCurrent(requestId)) {
        setLoading(false);
      }
    }
  };

  const handleGoUp = () => {
    // 提取父目录路径
    const parent = currentPath.replace(/\/[^/]+\/?$/, "") || "/";
    navigateTo(parent);
  };

  const handleInputSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = inputPath.trim();
    if (trimmed) navigateTo(trimmed);
  };

  const handleToggleHiddenDirectories = () => {
    const nextShowHiddenDirectories = !showHiddenDirectoriesRef.current;
    showHiddenDirectoriesRef.current = nextShowHiddenDirectories;
    setShowHiddenDirectories(nextShowHiddenDirectories);

    if (currentPath) {
      void navigateTo(currentPath, nextShowHiddenDirectories);
    }
  };

  const handleSelectCurrentPath = () => {
    const selectedPath = currentPath.trim();
    if (!selectedPath || loading) {
      return;
    }

    onSelect(selectedPath);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") onCancel();
  };

  const browserContent = (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div>
        <div className="mb-1 block text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "directoryBrowser.title" })}
        </div>

        {/* 路径输入 */}
        <form onSubmit={handleInputSubmit} className="flex flex-col gap-2 sm:flex-row">
          <Input
            type="text"
            size="lg"
            value={inputPath}
            onChange={(e) => setInputPath(e.target.value)}
            placeholder={intl.formatMessage({
              id: "directoryBrowser.pathPlaceholder",
            })}
            className="h-9 min-w-0 flex-1 text-ui-base"
            autoFocus
          />
          <div className="flex gap-2 sm:shrink-0">
            <Button
              type="submit"
              size="lg"
              className="h-9 min-w-0 flex-1 px-4 text-ui-base sm:flex-none"
            >
              {intl.formatMessage({ id: "directoryBrowser.go" })}
            </Button>
            <Button
              type="button"
              variant={showHiddenDirectories ? "secondary" : "outline"}
              size="lg"
              aria-pressed={showHiddenDirectories}
              className="h-9 min-w-0 flex-1 px-3 text-ui-base sm:flex-none"
              onClick={handleToggleHiddenDirectories}
            >
              {intl.formatMessage({
                id: showHiddenDirectories
                  ? "directoryBrowser.hideHidden"
                  : "directoryBrowser.showHidden",
              })}
            </Button>
          </div>
        </form>
      </div>

      {/* 错误提示 */}
      {error ? <div className="text-ui-base text-destructive">{error}</div> : null}

      {/* 目录列表 */}
      <div
        ref={listRef}
        className="flex-1 flex flex-col overflow-y-auto rounded-lg border border-border bg-background"
      >
        {/* 上级目录 */}
        {currentPath && currentPath !== "/" ? (
          <button
            onClick={handleGoUp}
            // 滚动容器是纵向 flex 布局，子项默认允许 shrink；
            // 当目录很多触发滚动时，首行“返回上级”会被压缩导致高度变化。
            className="flex h-10 w-full shrink-0 cursor-pointer items-center gap-2 border-b border-border px-3 text-left text-ui-base transition hover:bg-hover/50"
          >
            <FolderIcon className="size-4 shrink-0 text-foreground-subtle" />
            <span className="text-foreground">..</span>
          </button>
        ) : null}

        {loading ? (
          <div className="p-4 text-center text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "common.loading" })}
          </div>
        ) : entries.length === 0 ? (
          <div className="p-4 text-center text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "directoryBrowser.noSubdirs" })}
          </div>
        ) : (
          entries.map((entry) => {
            const EntryIcon =
              getDirectoryBrowserEntryIconKind(entry) === "folder-symlink"
                ? FolderSymlinkIcon
                : FolderIcon;

            return (
              <button
                key={entry.path}
                onClick={() => navigateTo(entry.path)}
                className="flex w-full shrink-0 cursor-pointer items-center gap-2 px-3 py-2 text-left text-ui-base transition hover:bg-hover/50"
              >
                <EntryIcon className="size-4 shrink-0 text-foreground-subtle" />
                <span className="truncate">{entry.name}</span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );

  if (embedded) {
    return browserContent;
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/30 backdrop-blur-sm"
      onClick={(e) => e.target === e.currentTarget && onCancel()}
      onKeyDown={handleKeyDown}
    >
      <div className="flex h-[min(36rem,calc(100vh-4rem))] w-[min(44rem,calc(100vw-2rem))] flex-col rounded-xl border border-border bg-popover p-4 shadow-xl">
        {browserContent}
        {/* 非嵌入模式之前只能继续进入子目录，没有确认当前目录的路径。
            Web 目录浏览器作为独立选择器使用时因此永远拿不到 onSelect 结果。
            这里把确认动作收口到弹窗 footer，选择当前浏览路径并交回上层。 */}
        <div className="mt-3 flex shrink-0 justify-end gap-2">
          <Button
            type="button"
            variant="secondary"
            size="lg"
            className="h-10 min-w-0 px-5 text-ui-base"
            onClick={onCancel}
          >
            {intl.formatMessage({ id: "common.cancel" })}
          </Button>
          <Button
            type="button"
            size="lg"
            className="h-10 min-w-0 px-5 text-ui-base"
            disabled={!currentPath.trim() || loading}
            onClick={handleSelectCurrentPath}
          >
            {intl.formatMessage({ id: "directoryBrowser.selectDir" })}
          </Button>
        </div>
      </div>
    </div>
  );
}
