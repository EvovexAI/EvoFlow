/* eslint-disable max-lines -- ProviderSettingsCard 集中维护 Bot 凭据、二维码和绑定状态机展示；后续拆分 provider 子组件后移除。 */
import {
  CircleAlert,
  Clock3,
  Copy,
  ExternalLink,
  KeyRound,
  LoaderCircle,
  QrCode,
  Unlink,
} from "lucide-react";
import QRCode from "qrcode";
import { useEffect, useState, type ReactNode } from "react";
import type { BotConfig, BotServiceStatus } from "@zcode/shared";
import { isFeishuBotProvider } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";
import { cn } from "@/components/lib/utils.js";
import { logger } from "@/logger.js";
import type { BindCodeState, FeishuRegistrationState, WeixinRegistrationState } from "./shared.js";
import { TELEGRAM_BOTFATHER_URL, formatBindCountdown } from "./shared.js";

function DetailPanel({ children }: { children: ReactNode }) {
  return <div className="rounded-lg bg-background p-3">{children}</div>;
}

function TelegramBotFatherQrPanel({
  credentialValue,
  secretSaving,
  onCredentialValueChange,
  onSaveSecret,
}: {
  credentialValue: string;
  secretSaving: boolean;
  onCredentialValueChange: (value: string) => void;
  onSaveSecret: () => void;
}) {
  const { intl } = useZCodeIntl();
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void QRCode.toDataURL(TELEGRAM_BOTFATHER_URL, {
      margin: 1,
      width: 220,
    })
      .then((dataUrl) => {
        if (!cancelled) {
          setQrDataUrl(dataUrl);
        }
      })
      .catch((error: unknown) => {
        logger.error(
          "[BotsDialog] 生成 Telegram BotFather 二维码失败",
          error instanceof Error ? error.message : String(error),
        );
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <DetailPanel>
      <div className="flex flex-wrap items-start justify-center gap-4">
        {qrDataUrl ? (
          <img
            src={qrDataUrl}
            alt={intl.formatMessage({ id: "bots.telegramBotFatherQrAlt" })}
            className="size-40 shrink-0 rounded-lg border border-border bg-surface p-2"
          />
        ) : null}
        <div className="min-w-52 flex-1 space-y-3 text-ui-base text-foreground-subtle">
          <div>{intl.formatMessage({ id: "bots.telegramBotFatherScanHint" })}</div>
          <div className="rounded-md bg-surface px-2 py-1 font-mono text-foreground">
            @BotFather
          </div>
          <div className="flex w-full min-w-0 items-center gap-2">
            <Input
              size="lg"
              type="password"
              value={credentialValue}
              onChange={(event) => onCredentialValueChange(event.target.value)}
              placeholder={intl.formatMessage({
                id: "bots.credentialPlaceholder",
              })}
              className="min-w-0 flex-1"
              disabled={secretSaving}
            />
            <Button
              variant="outline"
              size="lg"
              onClick={onSaveSecret}
              disabled={secretSaving || !credentialValue.trim()}
            >
              {secretSaving ? (
                <LoaderCircle className="size-4 animate-spin" />
              ) : (
                <KeyRound className="size-4" />
              )}
              {intl.formatMessage({ id: "bots.saveSecret" })}
            </Button>
          </div>
        </div>
      </div>
    </DetailPanel>
  );
}

export function ProviderSettingsCard({
  bot,
  runtime,
  credentialValue,
  bindCode,
  bindExpired,
  bindRemainingMs,
  bindCountdownProgress,
  feishuRegistration,
  feishuRegistrationLoading,
  weixinRegistration,
  weixinRegistrationLoading,
  weixinActivated,
  secretSaving,
  onCredentialValueChange,
  onSaveSecret,
  onRemoveSecret,
  onOpenTelegramBotFather,
  onStartWeixinRegistration,
  onStartFeishuRegistration,
  onCreateBindCode,
  onUnbind,
  onCopyBindCommand,
}: {
  bot: BotConfig;
  runtime: BotServiceStatus["botRuntime"][number] | undefined;
  credentialValue: string;
  bindCode: BindCodeState | null;
  bindExpired: boolean;
  bindRemainingMs: number;
  bindCountdownProgress: number;
  feishuRegistration: FeishuRegistrationState | null;
  feishuRegistrationLoading: boolean;
  weixinRegistration: WeixinRegistrationState | null;
  weixinRegistrationLoading: boolean;
  weixinActivated: boolean;
  secretSaving: boolean;
  onCredentialValueChange: (value: string) => void;
  onSaveSecret: () => void;
  onRemoveSecret: () => void;
  onOpenTelegramBotFather: () => void;
  onStartWeixinRegistration: () => void;
  onStartFeishuRegistration: () => void;
  onCreateBindCode: () => void;
  onUnbind: () => void;
  onCopyBindCommand: () => void;
}) {
  const { intl } = useZCodeIntl();
  if (bot.provider === "webhook") {
    return null;
  }
  const hasSecret = Boolean(bot.credentialRef);
  const isFeishuLike = isFeishuBotProvider(bot.provider);
  const isWeixin = bot.provider === "weixin";
  const isConnected = isWeixin ? hasSecret : Boolean(bot.providerUserId);
  const hasRuntimeError = runtime?.status === "error";
  const descriptionText =
    isFeishuLike && hasRuntimeError
      ? intl.formatMessage({
          id: isConnected
            ? "bots.runtime.boundConnectionInterruptedDescription"
            : "bots.runtime.credentialsSavedConnectionFailedDescription",
        })
      : intl.formatMessage({
          id: `bots.botTokenDescription.${bot.provider}`,
        });
  const hasActiveFeishuRegistration = feishuRegistration?.botId === bot.id;
  const hasActiveWeixinRegistration = weixinRegistration?.botId === bot.id;
  const showBindCode = bindCode?.botId === bot.id;

  let control: ReactNode = null;
  let detail: ReactNode = null;

  if (isConnected) {
    control = (
      <div className="flex items-center justify-end gap-3">
        <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-ui-base text-foreground-subtle">
          <span
            className={cn("size-2 rounded-full", hasRuntimeError ? "bg-destructive" : "bg-success")}
          />
          {intl.formatMessage({
            id: hasRuntimeError ? "bots.runtime.boundConnectionInterrupted" : "bots.connected",
          })}
        </span>
        <Button variant="outline" size="lg" onClick={isWeixin ? onRemoveSecret : onUnbind}>
          <Unlink className="size-4" />
          {intl.formatMessage({ id: "bots.unbind" })}
        </Button>
      </div>
    );
    if (isWeixin && !weixinActivated) {
      detail = (
        <DetailPanel>
          <div className="text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "bots.weixinActivationHint" })}
          </div>
        </DetailPanel>
      );
    }
  } else if (bot.provider === "telegram" && !hasSecret) {
    control = (
      <Button variant="outline" size="lg" onClick={onOpenTelegramBotFather}>
        <ExternalLink className="size-4" />
        {intl.formatMessage({ id: "bots.openBotFather" })}
      </Button>
    );
    detail = (
      <TelegramBotFatherQrPanel
        credentialValue={credentialValue}
        secretSaving={secretSaving}
        onCredentialValueChange={onCredentialValueChange}
        onSaveSecret={onSaveSecret}
      />
    );
  } else if ((isFeishuLike && !hasSecret) || (isWeixin && !hasSecret)) {
    const loading = isWeixin ? weixinRegistrationLoading : feishuRegistrationLoading;
    control = (
      <Button
        variant="outline"
        size="lg"
        onClick={isWeixin ? onStartWeixinRegistration : onStartFeishuRegistration}
        disabled={loading}
      >
        {loading ? <LoaderCircle className="size-4 animate-spin" /> : <QrCode className="size-4" />}
        {intl.formatMessage({ id: "bots.scanQrCode" })}
      </Button>
    );
  } else {
    control = (
      <div className="flex w-full flex-wrap justify-end gap-2">
        {!showBindCode && !hasRuntimeError ? (
          <Button variant="outline" size="lg" onClick={onCreateBindCode}>
            {intl.formatMessage({ id: "bots.bind" })}
          </Button>
        ) : null}
        <Button variant="outline" size="lg" onClick={onRemoveSecret}>
          {intl.formatMessage({ id: "bots.removeSecret" })}
        </Button>
      </div>
    );
  }

  if (isFeishuLike && hasRuntimeError) {
    const errorCode = runtime.message?.match(/\b\d{7,}\b/)?.[0];
    detail = (
      <DetailPanel>
        <div className="flex items-start gap-2">
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
          <div className="min-w-0 flex-1">
            <div className="text-ui-base font-medium text-foreground">
              {intl.formatMessage({
                id: isConnected
                  ? bot.provider === "lark"
                    ? "bots.runtime.larkConnectionInterrupted"
                    : "bots.runtime.feishuConnectionInterrupted"
                  : bot.provider === "lark"
                    ? "bots.runtime.cannotConnectLark"
                    : "bots.runtime.cannotConnectFeishu",
              })}
            </div>
            <div className="mt-1 text-ui-base leading-5 text-foreground-subtle">
              {intl.formatMessage({
                id: isConnected
                  ? bot.provider === "lark"
                    ? "bots.runtime.larkConnectionRecoverySuggestion"
                    : "bots.runtime.feishuConnectionRecoverySuggestion"
                  : "bots.runtime.connectionBlocksBinding",
              })}
            </div>
            <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-ui-base leading-5">
              {errorCode ? (
                <>
                  <dt className="text-foreground-subtle">
                    {intl.formatMessage({ id: "bots.runtime.errorCode" })}
                  </dt>
                  <dd className="min-w-0 break-all font-mono text-foreground">{errorCode}</dd>
                </>
              ) : null}
              <dt className="text-foreground-subtle">
                {intl.formatMessage({ id: "bots.runtime.errorDetail" })}
              </dt>
              <dd className="min-w-0 break-words text-foreground">
                {runtime.message ?? intl.formatMessage({ id: "bots.runtime.unknownError" })}
              </dd>
            </dl>
          </div>
        </div>
      </DetailPanel>
    );
  } else if (showBindCode) {
    const bindCommand = `/bind ${bindCode.code}`;
    detail = (
      <DetailPanel>
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-ui-base font-medium text-foreground">
              {intl.formatMessage({ id: "bots.bindCommand" })}
            </div>
            <div className="mt-1 text-ui-base leading-5 text-foreground-subtle">
              {intl.formatMessage({ id: "bots.bindCommandGuide" })}
            </div>
          </div>
          <Button variant="ghost" size="sm" onClick={onCreateBindCode}>
            <QrCode className="size-3" />
            {intl.formatMessage({ id: "bots.setup.refreshBindCode" })}
          </Button>
        </div>
        <div className="mt-3 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-md bg-surface px-2 py-1.5">
          <span
            className={cn(
              "min-w-0 break-all font-mono text-ui-base leading-5",
              bindExpired ? "text-foreground-subtle" : "text-foreground",
            )}
          >
            {bindCommand}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={onCopyBindCommand}
            disabled={bindExpired}
            title={intl.formatMessage({ id: "bots.copyBindCommand" })}
          >
            <Copy className="size-4" />
            {intl.formatMessage({ id: "bots.copyBindCommand" })}
          </Button>
        </div>
        <ol className="mt-2 list-decimal space-y-1 pl-4 text-ui-base leading-5 text-foreground-subtle">
          <li>{intl.formatMessage({ id: "bots.bindCommandStep.copy" })}</li>
          <li>{intl.formatMessage({ id: "bots.bindCommandStep.openChat" })}</li>
          <li>{intl.formatMessage({ id: "bots.bindCommandStep.send" })}</li>
        </ol>
        <div className="mt-2 flex items-center gap-2 text-ui-base text-foreground-subtle">
          <Clock3 className="size-3" />
          {bindExpired
            ? intl.formatMessage({ id: "bots.bindCodeExpired" })
            : intl.formatMessage(
                { id: "bots.bindCodeExpires" },
                { time: formatBindCountdown(bindRemainingMs) },
              )}
        </div>
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-surface">
          <div
            key={bindCode.code}
            className={cn(
              "h-full origin-left rounded-full transition-transform duration-300 ease-linear",
              bindExpired
                ? "bg-border"
                : bindCountdownProgress <= 10
                  ? "bg-destructive"
                  : bindRemainingMs <= 10_000
                    ? "bg-warning"
                    : "bg-primary",
            )}
            style={{ transform: `scaleX(${bindCountdownProgress / 100})` }}
          />
        </div>
      </DetailPanel>
    );
  } else if (hasActiveFeishuRegistration) {
    detail = (
      <DetailPanel>
        <div className="flex flex-wrap items-start justify-center gap-4">
          {feishuRegistration.qrDataUrl ? (
            <img
              src={feishuRegistration.qrDataUrl}
              alt={intl.formatMessage({ id: "bots.feishuRegistrationQrAlt" })}
              className="size-40 shrink-0 rounded-lg border border-border bg-surface p-2"
            />
          ) : null}
          <div className="min-w-52 flex-1 space-y-3 text-ui-base text-foreground-subtle">
            <div>
              {intl.formatMessage({
                id: `bots.feishuRegistrationScanHint.${feishuRegistration.domain}`,
              })}
            </div>
            <div className="rounded-md bg-surface px-2 py-1 font-mono text-foreground">
              {feishuRegistration.userCode}
            </div>
            <div>
              {feishuRegistration.status === "pending" ? (
                <span className="inline-flex items-center gap-1">
                  <LoaderCircle className="size-3 animate-spin" />
                  {intl.formatMessage({ id: "common.loading" })}
                </span>
              ) : (
                (feishuRegistration.message ??
                intl.formatMessage({
                  id: `bots.feishuRegistration.${feishuRegistration.status}`,
                }))
              )}
            </div>
          </div>
        </div>
      </DetailPanel>
    );
  } else if (hasActiveWeixinRegistration) {
    detail = (
      <DetailPanel>
        <div className="flex flex-wrap items-start justify-center gap-4">
          {weixinRegistration.qrDataUrl ? (
            <img
              src={weixinRegistration.qrDataUrl}
              alt={intl.formatMessage({ id: "bots.weixinRegistrationQrAlt" })}
              className="size-40 shrink-0 rounded-lg border border-border bg-surface p-2"
            />
          ) : null}
          <div className="min-w-52 flex-1 space-y-3 text-ui-base text-foreground-subtle">
            <div>{intl.formatMessage({ id: "bots.weixinRegistrationScanHint" })}</div>
            <div>
              {weixinRegistration.status === "pending" ||
              weixinRegistration.status === "scanned" ? (
                <span className="inline-flex items-center gap-1">
                  <LoaderCircle className="size-3 animate-spin" />
                  {intl.formatMessage({
                    id: `bots.weixinRegistration.${weixinRegistration.status}`,
                  })}
                </span>
              ) : (
                (weixinRegistration.message ??
                intl.formatMessage({
                  id: `bots.weixinRegistration.${weixinRegistration.status}`,
                }))
              )}
            </div>
          </div>
        </div>
      </DetailPanel>
    );
  }

  return (
    <SettingsGroupCard>
      <SettingsRow
        label={intl.formatMessage({ id: "bots.botToken" })}
        description={descriptionText}
        control={control}
        detail={
          bot.enabled && runtime?.deliveryError ? (
            <>
              <DetailPanel>
                <div role="alert" className="min-w-0 space-y-2 text-ui-base">
                  <div className="font-medium text-destructive">
                    {intl.formatMessage({ id: "bots.runtime.deliveryFailed" })}
                  </div>
                  <div className="text-foreground-subtle">
                    {intl.formatMessage({ id: "bots.runtime.deliveryFailedDescription" })}
                  </div>
                  <div className="whitespace-pre-wrap break-all text-foreground-subtle">
                    {runtime.deliveryError}
                  </div>
                </div>
              </DetailPanel>
              {detail}
            </>
          ) : (
            detail
          )
        }
      />
    </SettingsGroupCard>
  );
}
