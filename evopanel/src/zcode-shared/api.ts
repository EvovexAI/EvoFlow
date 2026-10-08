export interface ApiRequestInit extends RequestInit {
  timeoutMs?: number;
}

export interface ApiClient {
  request(input: string | URL, init?: ApiRequestInit): Promise<Response>;
}

export interface ApiErrorOptions {
  message: string;
  url: string;
  method?: string;
  status?: number;
  responseHeaders?: Record<string, string>;
  cause?: unknown;
}

export class ApiError extends Error {
  readonly url: string;
  readonly method: string;
  readonly status?: number;
  readonly responseHeaders?: Record<string, string>;

  constructor(options: ApiErrorOptions) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ApiError";
    this.url = options.url;
    this.method = (options.method ?? "GET").toUpperCase();
    this.status = options.status;
    this.responseHeaders = options.responseHeaders;
  }
}
