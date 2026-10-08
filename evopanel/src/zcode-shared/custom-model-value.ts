export const CUSTOM_MODEL_VALUE_PREFIX = "custom:";

export interface DecodedCustomModelValue {
  providerId: string;
  modelName?: string;
}

function safeDecodeUriComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function encodeCustomModelValue(providerId: string, modelName?: string): string {
  const encodedProviderId = encodeURIComponent(providerId);
  if (!modelName) {
    return `${CUSTOM_MODEL_VALUE_PREFIX}${encodedProviderId}`;
  }

  return `${CUSTOM_MODEL_VALUE_PREFIX}${encodedProviderId}:${encodeURIComponent(modelName)}`;
}

export function decodeCustomModelValue(value: string): DecodedCustomModelValue | null {
  if (!value.startsWith(CUSTOM_MODEL_VALUE_PREFIX)) {
    return null;
  }

  const body = value.slice(CUSTOM_MODEL_VALUE_PREFIX.length);
  const separatorIndex = body.indexOf(":");

  if (separatorIndex < 0) {
    return {
      providerId: safeDecodeUriComponent(body),
    };
  }

  const legacyParts = body.split(":");
  if (legacyParts.length >= 3 && legacyParts[0] === "builtin") {
    return {
      providerId: `${legacyParts[0]}:${legacyParts[1]}`,
      modelName: safeDecodeUriComponent(legacyParts.slice(2).join(":")),
    };
  }

  const encodedProviderId = body.slice(0, separatorIndex);
  const encodedModelName = body.slice(separatorIndex + 1);

  return {
    providerId: safeDecodeUriComponent(encodedProviderId),
    modelName: safeDecodeUriComponent(encodedModelName),
  };
}
