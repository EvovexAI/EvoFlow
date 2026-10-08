export const ZCODE_AGENT_PROVIDER_NOT_READY_CODE = "ZCODE_AGENT_PROVIDER_NOT_READY" as const;
export const ZCODE_AGENT_PROVIDER_NOT_READY_REASON = "provider_not_ready" as const;

export type ModelSelectionGhostReason =
  | "mismatch"
  | "no-preference"
  | "providers-not-ready"
  | "unresolved-config";

export type ModelSelectionUiErrorCode =
  | "CONFIG_READ_FAILED"
  | "CONFIG_PARSE_FAILED"
  | "CONFIG_INVALID_SCHEMA"
  | "CONFIG_REQUIRED_FIELD_MISSING";

export interface ModelSelectionUiError {
  code: ModelSelectionUiErrorCode;
  i18nKey: string;
  detail?: string;
}

export interface ModelSelectionResolution {
  selectedSupplierKey: string;
  selectedModel: string | null;
  isGhostSupplier: boolean;
  supplierMismatchReason: ModelSelectionGhostReason | null;
  uiError: ModelSelectionUiError | null;
  shouldClearLocalPreference: boolean;
}
