import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from "react";
import type { ReactNode } from "react";
import type { Locale, LocalePreference } from "@zcode/shared";
import { DEFAULT_LOCALE } from "@zcode/shared";
import type { BroadcastMessage, IBroadcastService, ISettingService } from "@zcode/services";
import {
  readNavigatorLanguage,
  readSafeLocalStorage,
  writeSafeLocalStorage,
} from "@/lib/browserEnvironment.js";
import zhCN from "./locales/zh-CN.js";
import enUS from "./locales/en-US.js";

/** 语言 → 翻译消息映射 */
const MESSAGES: Record<Locale, Record<string, string>> = {
  "zh-CN": zhCN,
  "en-US": enUS,
};

/** 简易 intl 工具：根据 id 查找翻译，支持 {key} 占位符替换 */
export interface IntlInstance {
  formatMessage(descriptor: { id: string }, values?: Record<string, string | number>): string;
}

const LOCALE_PREFERENCE_KEY = "zcode-locale-preference";
const STATE_LOCALE_CHANNEL = "state:locale";

interface LocaleBroadcastPayload {
  preference: LocalePreference;
  resolvedLocale: Locale;
}

function isLocale(value: unknown): value is Locale {
  return value === "zh-CN" || value === "en-US";
}

function isLocalePreference(value: unknown): value is LocalePreference {
  return value === "system" || isLocale(value);
}

function resolveLocaleBroadcastPayload(payload: unknown): LocaleBroadcastPayload | null {
  if (isLocale(payload)) {
    return {
      preference: payload,
      resolvedLocale: payload,
    };
  }

  if (!payload || typeof payload !== "object") {
    return null;
  }

  const candidate = payload as Partial<LocaleBroadcastPayload>;
  if (isLocalePreference(candidate.preference) && isLocale(candidate.resolvedLocale)) {
    return {
      preference: candidate.preference,
      resolvedLocale: candidate.resolvedLocale,
    };
  }

  return null;
}

function resolveLocalePreferenceFromSettings({
  storedPreference,
  settingsLocale,
  settingsLocalePreference,
  preferSettingServiceLocale,
}: {
  storedPreference: LocalePreference | null;
  settingsLocale: Locale | undefined;
  settingsLocalePreference: LocalePreference | undefined;
  preferSettingServiceLocale: boolean;
}): LocalePreference | null {
  if (preferSettingServiceLocale && settingsLocale) {
    if (settingsLocalePreference === "system") {
      return settingsLocale;
    }
    return settingsLocale;
  }

  return storedPreference ?? settingsLocalePreference ?? settingsLocale ?? null;
}

function shouldApplyLocaleBroadcastMessage(
  message: Pick<BroadcastMessage, "channel" | "payload" | "sourceWindowId">,
  options: {
    ignoredLocalPayload?: LocaleBroadcastPayload | null;
  } = {},
): message is Pick<BroadcastMessage, "channel"> & { payload: Locale | LocaleBroadcastPayload } {
  const payload = resolveLocaleBroadcastPayload(message.payload);
  if (message.channel !== STATE_LOCALE_CHANNEL || !payload) {
    return false;
  }
  if (
    message.sourceWindowId === undefined &&
    options.ignoredLocalPayload?.preference === payload.preference &&
    options.ignoredLocalPayload.resolvedLocale === payload.resolvedLocale
  ) {
    return false;
  }
  return true;
}

function createIntl(locale: Locale): IntlInstance {
  // noUncheckedIndexedAccess：用 ?? 回退到默认语言的翻译
  const messages = MESSAGES[locale] ?? MESSAGES[DEFAULT_LOCALE]!;
  return {
    formatMessage({ id }, values) {
      let msg = messages[id] ?? id;
      if (values) {
        for (const [key, val] of Object.entries(values)) {
          msg = msg.replaceAll(`{${key}}`, String(val));
        }
      }
      return msg;
    },
  };
}

interface IntlContextValue {
  intl: IntlInstance;
  locale: Locale;
  localePreference: LocalePreference;
  setLocale: (locale: Locale) => void;
  setLocalePreference: (localePreference: LocalePreference) => void;
}

const IntlContext = createContext<IntlContextValue | null>(null);

/**
 * 国际化 Provider —— 管理当前语言和 intl 实例。
 * 如果传入 settingService，会从设置中读取初始语言并在切换时持久化。
 */
export function ZCodeIntlProvider({
  children,
  settingService,
  broadcastService,
  initialLocale,
  preferSettingServiceLocale = false,
  resolveSystemLocale: resolveHostSystemLocale,
}: {
  children: ReactNode;
  settingService?: ISettingService;
  broadcastService?: Pick<IBroadcastService, "send" | "onMessage">;
  initialLocale?: Locale;
  preferSettingServiceLocale?: boolean;
  resolveSystemLocale?: () => Locale | Promise<Locale>;
}) {
  const applyingBroadcastRef = useRef(false);
  const ignoredLocalLocaleBroadcastPayloadRef = useRef<LocaleBroadcastPayload | null>(null);
  const localePreferenceOperationSeqRef = useRef(0);
  const resolveNavigatorSystemLocale = useCallback((): Locale => {
    const language = readNavigatorLanguage();
    if (!language) {
      return DEFAULT_LOCALE;
    }

    return language.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US";
  }, []);
  const resolveSystemLocale = useCallback(async (): Promise<Locale> => {
    const resolvedLocale = await resolveHostSystemLocale?.();
    if (isLocale(resolvedLocale)) {
      return resolvedLocale;
    }
    return resolveNavigatorSystemLocale();
  }, [resolveHostSystemLocale, resolveNavigatorSystemLocale]);

  const readStoredPreference = useCallback((): LocalePreference | null => {
    const raw = readSafeLocalStorage(LOCALE_PREFERENCE_KEY);
    if (isLocalePreference(raw)) {
      return raw;
    }
    return null;
  }, []);

  const persistLocalePreference = useCallback((preference: LocalePreference) => {
    writeSafeLocalStorage(LOCALE_PREFERENCE_KEY, preference);
  }, []);

  const [localePreference, setLocalePreferenceState] = useState<LocalePreference>(
    () => initialLocale ?? readStoredPreference() ?? "system",
  );
  const [systemLocale, setSystemLocale] = useState<Locale>(() => resolveNavigatorSystemLocale());
  const enqueueLocalePreferenceUpdate = useCallback(
    (operationSeq: number, resolvedLocale: Locale, preference: LocalePreference) => {
      if (localePreferenceOperationSeqRef.current !== operationSeq) {
        return;
      }

      // Provider 层不能把持久化 RPC 串成无界等待链。
      // 一次 settingService.update 永久 pending 时，后续语言选择仍要继续尝试落盘；
      // 底层 settingService 负责文件写入顺序，这里只做最新操作校验和错误收口。
      void settingService
        ?.update({
          locale: resolvedLocale,
          localePreference: preference,
        })
        .catch(() => {
          // 持久化失败不阻断 UI 状态和跨窗口广播，下一次语言操作会再次尝试写入。
        });
    },
    [settingService],
  );

  // 从 settingService 读取持久化的 locale
  useEffect(() => {
    if (!settingService) return;
    let disposed = false;
    const initialOperationSeq = localePreferenceOperationSeqRef.current;
    settingService.get().then(async (settings) => {
      if (disposed || localePreferenceOperationSeqRef.current !== initialOperationSeq) {
        return;
      }
      const nextPreference = resolveLocalePreferenceFromSettings({
        storedPreference: readStoredPreference(),
        settingsLocale: settings.locale,
        settingsLocalePreference: settings.localePreference,
        preferSettingServiceLocale,
      });
      if (disposed) {
        return;
      }
      if (nextPreference) {
        // 手机远控和桌面连接到同一个 settingService，但手机浏览器本地可能残留
        // en-US/system 偏好。远控入口必须以桌面 setting.json 为准，否则会出现桌面中文、手机英文。
        setLocalePreferenceState(nextPreference);
        if (preferSettingServiceLocale) {
          persistLocalePreference(nextPreference);
        }
        if (nextPreference === "system") {
          const resolvedLocale = await resolveSystemLocale();
          if (disposed || localePreferenceOperationSeqRef.current !== initialOperationSeq) {
            return;
          }
          setSystemLocale(resolvedLocale);
          if (settings.locale !== resolvedLocale) {
            // setting.json 里的 locale 是 main 进程菜单、远控等非浏览器上下文的实际语言。
            // system 模式必须使用宿主系统语言；Electron renderer 的 navigator.language 可能和
            // macOS app.getLocale() 不一致，直接写回会把中文系统错误持久化成英文。
            enqueueLocalePreferenceUpdate(initialOperationSeq, resolvedLocale, "system");
          }
        }
      }
    });
    return () => {
      disposed = true;
    };
  }, [
    persistLocalePreference,
    preferSettingServiceLocale,
    readStoredPreference,
    enqueueLocalePreferenceUpdate,
    resolveSystemLocale,
    settingService,
  ]);

  const locale = useMemo<Locale>(() => {
    return localePreference === "system" ? systemLocale : localePreference;
  }, [localePreference, systemLocale]);

  const setLocalePreference = useCallback(
    (newPreference: LocalePreference) => {
      const operationSeq = localePreferenceOperationSeqRef.current + 1;
      localePreferenceOperationSeqRef.current = operationSeq;
      setLocalePreferenceState(newPreference);
      persistLocalePreference(newPreference);
      void (async () => {
        const resolvedLocale =
          newPreference === "system" ? await resolveSystemLocale() : newPreference;
        if (localePreferenceOperationSeqRef.current !== operationSeq) {
          return;
        }
        if (newPreference === "system") {
          setSystemLocale(resolvedLocale);
        }
        const broadcastPayload: LocaleBroadcastPayload = {
          preference: newPreference,
          resolvedLocale,
        };
        if (!applyingBroadcastRef.current && broadcastService) {
          // 跨窗口语言同步不能等待 settingService 持久化 RPC。
          // 持久化可能超时或拒绝，但本地 UI 与其他窗口应先按用户最后一次选择同步。
          ignoredLocalLocaleBroadcastPayloadRef.current = broadcastPayload;
          void broadcastService
            .send({
              channel: STATE_LOCALE_CHANNEL,
              payload: broadcastPayload,
            })
            .finally(() => {
              if (
                ignoredLocalLocaleBroadcastPayloadRef.current?.preference ===
                  broadcastPayload.preference &&
                ignoredLocalLocaleBroadcastPayloadRef.current.resolvedLocale ===
                  broadcastPayload.resolvedLocale
              ) {
                ignoredLocalLocaleBroadcastPayloadRef.current = null;
              }
            });
        }
        enqueueLocalePreferenceUpdate(operationSeq, resolvedLocale, newPreference);
      })();
    },
    [broadcastService, enqueueLocalePreferenceUpdate, persistLocalePreference, resolveSystemLocale],
  );

  useEffect(() => {
    if (!broadcastService) {
      return;
    }

    const subscription = broadcastService.onMessage((message) => {
      if (
        !shouldApplyLocaleBroadcastMessage(message, {
          ignoredLocalPayload: ignoredLocalLocaleBroadcastPayloadRef.current,
        })
      ) {
        return;
      }

      ignoredLocalLocaleBroadcastPayloadRef.current = null;
      const payload = resolveLocaleBroadcastPayload(message.payload);
      if (!payload) {
        return;
      }
      applyingBroadcastRef.current = true;
      try {
        // 语言切换真实发生在 IntlProvider，不能只依赖 store 里的 locale 字段。
        // 结构化广播需要同时携带用户偏好和解析语言，避免 system 被其他窗口降级成固定语言。
        localePreferenceOperationSeqRef.current += 1;
        setLocalePreferenceState(payload.preference);
        persistLocalePreference(payload.preference);
        setSystemLocale(payload.resolvedLocale);
      } finally {
        applyingBroadcastRef.current = false;
      }
    });

    return () => subscription.dispose();
  }, [broadcastService, persistLocalePreference]);

  const setLocale = useCallback(
    (newLocale: Locale) => {
      setLocalePreference(newLocale);
    },
    [setLocalePreference],
  );

  const intl = useMemo(() => createIntl(locale), [locale]);

  const value = useMemo<IntlContextValue>(
    () => ({ intl, locale, localePreference, setLocale, setLocalePreference }),
    [intl, locale, localePreference, setLocale, setLocalePreference],
  );

  return <IntlContext value={value}>{children}</IntlContext>;
}

/** 获取 intl 上下文 */
export function useZCodeIntl(): IntlContextValue {
  const ctx = useContext(IntlContext);
  if (!ctx) {
    throw new Error("useZCodeIntl 必须在 ZCodeIntlProvider 内使用");
  }
  return ctx;
}
