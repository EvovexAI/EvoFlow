/* eslint-disable max-lines -- 商店详情页把 hero/示例提示词/组件分区/信息区/高级折叠组织为一个连贯页面，与截图 1:1 对齐。 */
import { useState, type ReactNode } from "react";
import {
  Anchor,
  ArrowRight,
  Bot,
  ChevronRight,
  ExternalLink,
  Loader2,
  MessagesSquare,
  RefreshCw,
  Server,
  Terminal,
  TriangleAlert,
  WandSparkles,
} from "lucide-react";
import type { ZCodePluginComponentKind, ZCodePluginsDescribeResult } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { PluginStoreAvatar } from "@/settings/PluginStoreAvatar.js";
import { ThemeHeroVisual } from "@/openWorkspacePageThemeHero.js";
import documentsIconUrl from "@/assets/document-skill-icons/documents@2x.png";
import pdfIconUrl from "@/assets/document-skill-icons/pdf@2x.png";
import spreadsheetsIconUrl from "@/assets/document-skill-icons/spreadsheets@2x.png";
import {
  PluginStoreInstallButton,
  PluginStoreItemMenu,
  PluginStorePaidPlanBadge,
  type PluginStoreActions,
} from "@/settings/PluginStoreCard.js";
import {
  isTrustedImageUrl,
  KNOWN_CATEGORY_LABEL_IDS,
  resolveItemDescription,
  resolveStoreCategory,
  resolveItemDisplayName,
  resolveLocalizedList,
  type StorePluginItem,
} from "@/settings/pluginStoreListing.js";
import {
  buildInstalledPluginDisplayGroups,
  describeResultToDisplayGroups,
} from "@/settings/pluginManagedResourceGroups.js";
import type { PluginComponentDisplayGroup } from "@/settings/PluginComponentGroups.js";
import type { PluginDescribeEntry } from "@/store/pluginManagementStore.js";

// 组件分区顺序与截图一致：MCP 服务器 → 技能 → 命令 → 子智能体 → Hooks。
const SECTION_ORDER: ZCodePluginComponentKind[] = ["mcp", "skill", "command", "agent", "hook"];

const SECTION_TITLE_IDS: Record<ZCodePluginComponentKind, string> = {
  mcp: "settings.plugins.store.section.mcp",
  skill: "settings.plugins.store.section.skills",
  command: "settings.plugins.store.section.commands",
  agent: "settings.plugins.store.section.agents",
  hook: "settings.plugins.store.section.hooks",
};

// 与各资源设置列表共用同一图标语义，避免详情页用近似图标造成识别不一致。
const SECTION_ICONS: Record<ZCodePluginComponentKind, typeof Server> = {
  mcp: Server,
  skill: WandSparkles,
  command: Terminal,
  agent: Bot,
  hook: Anchor,
};

type ExamplePromptDocumentIcon = "documents" | "pdf" | "spreadsheets";

const EXAMPLE_PROMPT_DOCUMENT_ICON_URLS: Record<ExamplePromptDocumentIcon, string> = {
  documents: documentsIconUrl,
  pdf: pdfIconUrl,
  spreadsheets: spreadsheetsIconUrl,
};

function resolveExamplePromptDocumentIcon(prompt: string): ExamplePromptDocumentIcon {
  if (/\bpdf\b/iu.test(prompt)) {
    return "pdf";
  }
  if (/\b(?:csv|xlsx|excel)\b/iu.test(prompt)) {
    return "spreadsheets";
  }
  return "documents";
}

export function PluginStoreDetailView({
  item,
  actions,
  describeEntry,
  onRetryDescribe,
  onUsePrompt,
  advanced,
}: {
  item: StorePluginItem;
  actions: PluginStoreActions;
  describeEntry?: PluginDescribeEntry;
  onRetryDescribe: () => void;
  /** 试用：标准新建任务并预填 canonical Plugin 引用 + 示例提示词（不自动发送）；未安装时先引导安装。 */
  onUsePrompt: (item: StorePluginItem, prompt: string) => void;
  /** 高级折叠区（rootPath/Hook 明细/配置项），仅已安装且有运行时信息时由父级注入。 */
  advanced?: ReactNode;
}) {
  const { intl, locale } = useZCodeIntl();
  const displayName = resolveItemDisplayName(item, locale);
  const description = resolveItemDescription(item, locale);
  const heroImage = item.listing?.heroImage;
  const examplePrompts =
    resolveLocalizedList(locale, item.listing?.examplePrompts, item.listing?.examplePromptsI18n) ??
    [];
  const describeMetadata =
    describeEntry?.status === "loaded" ? describeEntry.data?.metadata : undefined;

  const componentGroups: PluginComponentDisplayGroup[] = item.info
    ? buildInstalledPluginDisplayGroups(item.info)
    : describeEntry?.status === "loaded" && describeEntry.data
      ? describeResultToDisplayGroups(describeEntry.data)
      : [];
  const orderedGroups = SECTION_ORDER.map((kind) =>
    componentGroups.find((group) => group.kind === kind),
  ).filter((group): group is PluginComponentDisplayGroup => group !== undefined);
  const componentsLoading = !item.info && (describeEntry?.status ?? "loading") === "loading";
  const componentsFailed = !item.info && describeEntry?.status === "error";

  return (
    <div className="space-y-8" data-testid="plugin-store-detail" data-plugin-id={item.id}>
      {/* 头部：大图标后，显示名与菜单/主按钮同排；简介和来源提示另起一行。 */}
      <div className="space-y-3">
        <PluginStoreAvatar item={item} className="size-16 rounded-2xl" iconClassName="size-6" />
        <div
          className="flex min-w-0 items-center justify-between gap-3"
          data-testid="plugin-store-title-actions"
        >
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="min-w-0 truncate text-2xl font-semibold tracking-tight text-foreground">
              {displayName}
            </h1>
            <PluginStorePaidPlanBadge item={item} />
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {item.installed ? (
              <>
                <PluginStoreItemMenu
                  item={item}
                  actions={actions}
                  triggerVariant="outline"
                  triggerSize="icon-lg"
                />
                {/* 顶部试用与示例提示词共用同一 canonical 构造；空 prompt 表示只预填 Plugin mention。 */}
                <Button
                  type="button"
                  variant="default"
                  size="lg"
                  data-testid="plugin-store-try-now"
                  data-plugin-id={item.id}
                  onClick={() => onUsePrompt(item, "")}
                >
                  <MessagesSquare className="size-3.5" aria-hidden="true" />
                  {intl.formatMessage({ id: "settings.plugins.store.tryNow" })}
                </Button>
              </>
            ) : (
              <>
                {actions.onResetConfig ? (
                  <PluginStoreItemMenu
                    item={item}
                    actions={actions}
                    triggerVariant="outline"
                    triggerSize="icon-lg"
                  />
                ) : null}
                <PluginStoreInstallButton item={item} actions={actions} size="lg" />
              </>
            )}
          </div>
        </div>
        {description ? (
          <p data-testid="plugin-store-description" className="text-ui-base text-foreground-subtle">
            {description}
          </p>
        ) : null}
        {item.orphaned ? (
          <p
            data-testid="plugin-store-source-degraded"
            data-plugin-id={item.id}
            className="flex items-center gap-1.5 text-ui-base text-warning"
          >
            <TriangleAlert className="size-3.5 shrink-0" aria-hidden="true" />
            {intl.formatMessage({ id: "settings.plugins.store.sourceMissing" })}
          </p>
        ) : null}
      </div>

      {/* Hero 区：横幅图上垂直堆叠示例提示词胶囊；无图但有提示词 → 纯胶囊列表；两者皆无 → 不渲染。 */}
      {isTrustedImageUrl(heroImage) || examplePrompts.length > 0 ? (
        <HeroSection
          item={item}
          displayName={displayName}
          examplePrompts={examplePrompts}
          heroImage={heroImage}
          onUsePrompt={onUsePrompt}
        />
      ) : null}

      {/* 组件分区：已安装走权威枚举（ZCodePluginInfo.components），候选走 plugins/describe 按需拉取。 */}
      {componentsLoading ? (
        <div
          className="flex items-center gap-2 py-2 text-ui-base text-foreground-subtle"
          data-testid="plugin-store-components-loading"
        >
          <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
          <span>
            {intl.formatMessage({ id: "settings.plugins.marketplace.componentsLoading" })}
          </span>
        </div>
      ) : componentsFailed ? (
        <div
          className="flex items-center justify-between gap-2 rounded-xl border border-warning/30 bg-warning/10 px-3 py-2 text-ui-base text-foreground-subtle"
          data-testid="plugin-store-components-error"
        >
          <span>{intl.formatMessage({ id: "settings.plugins.marketplace.componentsError" })}</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="plugin-store-components-retry"
            onClick={onRetryDescribe}
          >
            <RefreshCw className="size-3" aria-hidden="true" />
            {intl.formatMessage({ id: "settings.plugins.marketplace.componentsRetry" })}
          </Button>
        </div>
      ) : (
        orderedGroups.map((group) => <ComponentSection key={group.kind} group={group} />)
      )}

      {/* 信息区：listing 优先，manifest（运行时/describe）回退；无值整行省略。 */}
      <InfoSection item={item} describeMetadata={describeMetadata} />

      {advanced}
    </div>
  );
}

function HeroSection({
  item,
  displayName,
  examplePrompts,
  heroImage,
  onUsePrompt,
}: {
  item: StorePluginItem;
  displayName: string;
  examplePrompts: string[];
  heroImage: string | undefined;
  onUsePrompt: (item: StorePluginItem, prompt: string) => void;
}) {
  const [heroFailed, setHeroFailed] = useState(false);
  const showHeroImage = isTrustedImageUrl(heroImage) && !heroFailed;
  const prompts = examplePrompts.map((prompt) => {
    const documentIcon = resolveExamplePromptDocumentIcon(prompt);
    return (
      <button
        key={prompt}
        type="button"
        data-testid="plugin-store-example-prompt"
        data-plugin-id={item.id}
        // 彩色 Hero 上统一使用参考图的深色半透明胶囊，不随底图有无切换为普通卡片。
        className="group/prompt flex w-fit max-w-2xl items-center gap-2.5 rounded-3xl bg-black/75 px-3.5 py-2.5 text-left text-ui-base text-white shadow-lg backdrop-blur-md transition-colors hover:bg-black/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
        onClick={() => onUsePrompt(item, prompt)}
      >
        <img
          src={EXAMPLE_PROMPT_DOCUMENT_ICON_URLS[documentIcon]}
          alt=""
          aria-hidden="true"
          className="size-7 shrink-0 object-contain"
        />
        <span className="shrink-0 font-medium text-white/70">{displayName}</span>
        <span className="min-w-0 whitespace-normal">{prompt}</span>
        <span
          aria-hidden="true"
          className="flex size-9 shrink-0 items-center justify-center rounded-full bg-white/15 transition-colors group-hover/prompt:bg-white/25"
        >
          <ArrowRight className="size-4" />
        </span>
      </button>
    );
  });

  if (!showHeroImage && prompts.length === 0) return null;

  return (
    <div
      className="relative min-h-72 overflow-hidden rounded-3xl sm:aspect-[3/1] sm:min-h-0"
      data-testid="plugin-store-hero"
    >
      <ThemeHeroVisual className="pointer-events-none absolute inset-0" />
      {showHeroImage ? (
        <img
          src={heroImage}
          alt=""
          aria-hidden="true"
          draggable={false}
          className="absolute inset-0 size-full select-none object-cover opacity-80"
          onError={() => setHeroFailed(true)}
        />
      ) : null}
      <div
        className="absolute inset-0 bg-black/15"
        data-testid="plugin-store-hero-overlay"
        aria-hidden="true"
      />
      {prompts.length > 0 ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 p-5 sm:p-8">
          {prompts}
        </div>
      ) : null}
    </div>
  );
}

function ComponentSection({ group }: { group: PluginComponentDisplayGroup }) {
  const { intl } = useZCodeIntl();
  const Icon = SECTION_ICONS[group.kind];
  return (
    <section data-testid="plugin-store-component-section" data-component-kind={group.kind}>
      <div className="flex items-baseline gap-2 border-b border-border pb-2">
        <h2 className="text-ui-lg font-semibold text-foreground">
          {intl.formatMessage({ id: SECTION_TITLE_IDS[group.kind] })}
        </h2>
        <span className="text-ui-base text-foreground-subtle">{group.count}</span>
      </div>
      <ul className="mt-1 divide-y divide-border/60">
        {group.items.map((componentItem) => (
          <li key={componentItem.name} className="flex min-w-0 items-center gap-3 py-2.5">
            <span
              aria-hidden="true"
              className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-surface text-foreground-subtle"
            >
              <Icon className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-ui-base font-medium text-foreground">
                {componentItem.name}
              </div>
              {componentItem.description ? (
                <div className="mt-0.5 line-clamp-1 text-ui-base text-foreground-subtle">
                  {componentItem.description}
                </div>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function InfoSection({
  item,
  describeMetadata,
}: {
  item: StorePluginItem;
  describeMetadata: ZCodePluginsDescribeResult["metadata"];
}) {
  const { intl } = useZCodeIntl();
  const platform = useOptionalPlatform();
  const listing = item.listing;
  const developer = listing?.author ?? item.info?.author ?? describeMetadata?.author;
  const category = resolveStoreCategory(listing?.category);
  const categoryLabelId = category ? KNOWN_CATEGORY_LABEL_IDS[category] : undefined;
  const categoryLabel = category
    ? categoryLabelId
      ? intl.formatMessage({ id: categoryLabelId })
      : category
    : undefined;
  const version =
    item.info?.version ??
    item.installedMeta?.version ??
    item.summary?.version ??
    describeMetadata?.version;
  const website = pickHttpsUrl(listing?.homepage, item.info?.homepage, describeMetadata?.homepage);
  const privacyPolicy = pickHttpsUrl(listing?.privacyPolicy);
  const termsOfService = pickHttpsUrl(listing?.termsOfService);

  const rows: Array<{ key: string; label: string; value: ReactNode }> = [];
  if (developer) {
    rows.push({
      key: "developer",
      label: intl.formatMessage({ id: "settings.plugins.store.info.developer" }),
      value: developer,
    });
  }
  if (categoryLabel) {
    rows.push({
      key: "category",
      label: intl.formatMessage({ id: "settings.plugins.store.info.category" }),
      value: categoryLabel,
    });
  }
  if (version) {
    rows.push({
      key: "version",
      label: intl.formatMessage({ id: "settings.plugins.store.info.version" }),
      value: version,
    });
  }
  const linkRows: Array<{ key: string; label: string; url: string }> = [];
  if (website) {
    linkRows.push({
      key: "website",
      label: intl.formatMessage({ id: "settings.plugins.store.info.website" }),
      url: website,
    });
  }
  if (privacyPolicy) {
    linkRows.push({
      key: "privacyPolicy",
      label: intl.formatMessage({ id: "settings.plugins.store.info.privacyPolicy" }),
      url: privacyPolicy,
    });
  }
  if (termsOfService) {
    linkRows.push({
      key: "termsOfService",
      label: intl.formatMessage({ id: "settings.plugins.store.info.termsOfService" }),
      url: termsOfService,
    });
  }
  if (rows.length === 0 && linkRows.length === 0) return null;

  return (
    <section>
      <div className="border-b border-border pb-2">
        <h2 className="text-ui-lg font-semibold text-foreground">
          {intl.formatMessage({ id: "settings.plugins.store.info.title" })}
        </h2>
      </div>
      <dl className="mt-3 space-y-2.5">
        {rows.map((row) => (
          <div key={row.key} className="grid grid-cols-[8rem_minmax(0,1fr)] items-baseline gap-3">
            <dt className="text-ui-base text-foreground-subtle">{row.label}</dt>
            <dd className="min-w-0 truncate text-ui-base text-foreground">{row.value}</dd>
          </div>
        ))}
        {linkRows.map((row) => (
          <div key={row.key} className="grid grid-cols-[8rem_minmax(0,1fr)] items-baseline gap-3">
            <dt className="text-ui-base text-foreground-subtle">{row.label}</dt>
            <dd className="min-w-0">
              <button
                type="button"
                title={row.url}
                aria-label={`${row.label}: ${row.url}`}
                className="inline-flex items-center gap-1 rounded-md text-ui-base text-foreground transition-colors hover:text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
                onClick={() => platform?.openExternal(row.url)}
              >
                <ExternalLink className="size-3.5" aria-hidden="true" />
              </button>
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** 外链只放行 https（信息区渲染层统一收口，schema 不做校验）。 */
function pickHttpsUrl(...candidates: Array<string | undefined>): string | undefined {
  return candidates.find(
    (candidate): candidate is string =>
      typeof candidate === "string" && candidate.startsWith("https://"),
  );
}

/** 高级折叠区外壳：详情页底部的「更多详情」，内容由父级注入（rootPath/Hook 明细/配置）。 */
export function PluginStoreAdvancedSection({ children }: { children: ReactNode }) {
  const { intl } = useZCodeIntl();
  return (
    <details
      className="group/advanced border-t border-border pt-4"
      data-testid="plugin-store-advanced"
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 text-ui-base font-medium text-foreground-subtle transition-colors hover:text-foreground">
        <ChevronRight
          className="size-3.5 transition-transform group-open/advanced:rotate-90"
          aria-hidden="true"
        />
        {intl.formatMessage({ id: "settings.plugins.detail.moreDetails" })}
      </summary>
      <div className="mt-3 space-y-3">{children}</div>
    </details>
  );
}
