import { createUuid } from "@zcode/shared";

export const REQUEST_ID_HEADER_NAME = "x-request-id";

export function withRequestIdHeader(headers: RequestInit["headers"] | undefined): Headers {
  const next = new Headers(headers);
  if (!next.has(REQUEST_ID_HEADER_NAME)) {
    next.set(REQUEST_ID_HEADER_NAME, createUuid());
  }
  return next;
}

export function withRequestIdHeaderRecord(
  headers: RequestInit["headers"] | undefined,
): Record<string, string> {
  const next: Record<string, string> = {};

  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      next[key] = value;
    });
  } else if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      next[key] = value;
    }
  } else if (headers) {
    Object.entries(headers).forEach(([key, value]) => {
      next[key] = String(value);
    });
  }

  if (!Object.keys(next).some((key) => key.toLowerCase() === REQUEST_ID_HEADER_NAME)) {
    next[REQUEST_ID_HEADER_NAME] = createUuid();
  }
  return next;
}
