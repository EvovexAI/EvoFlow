import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const BROKER_SOCKET_ENV = "ZCODE_CUA_PERMISSION_BROKER_SOCKET";
export const BROKER_UNAVAILABLE_ENV = "ZCODE_CUA_PERMISSION_BROKER_UNAVAILABLE";

export class BrokerError extends Error {
  constructor(message, options = {}) {
    super(message ?? "Computer Use broker is unavailable.");
    this.name = "BrokerError";
    this.code = options.code ?? "unavailable";
    if (options.details !== undefined) this.details = options.details;
  }
}

export class CuaHelperError extends Error {
  constructor(message, options = {}) {
    super(message ?? "Computer Use Helper is unavailable.");
    this.name = "CuaHelperError";
    this.code = options.code ?? "helper_unavailable";
  }
}

export function isCuaHelperError(value) {
  return value instanceof CuaHelperError;
}

const brokerErrorFactory = (code) => (message, details) =>
  new BrokerError(message ?? code, { code, details });

export const notAuthorized = brokerErrorFactory("not_authorized");
export const notSelectable = brokerErrorFactory("not_selectable");
export const notSettable = brokerErrorFactory("not_settable");
export const elementUnavailable = brokerErrorFactory("element_unavailable");
export const actionUnavailable = brokerErrorFactory("action_unavailable");
export const foregroundRequired = brokerErrorFactory("foreground_required");

export async function callBrokerMethod(_args) {
  throw new BrokerError("Computer Use is not available in this build.");
}

export async function probeHelperHealth(_socketPath, _options) {
  return { bundleId: null, pid: null };
}

export function mintBrokerSocketPath(options = {}) {
  const dir = typeof options.dir === "string" ? options.dir : tmpdir();
  return join(dir, `zcode-cua-broker-${randomUUID()}.sock`);
}

export function resolveBrokerSocketPath(options = {}) {
  const env = options.env ?? process.env;
  const fromEnv = env[BROKER_SOCKET_ENV];
  if (typeof fromEnv === "string" && fromEnv.trim()) return fromEnv;
  return mintBrokerSocketPath(options);
}

export function parseRequestLine(_line) {
  return undefined;
}

export function okResponse(result) {
  return { ok: true, result };
}

export function errorResponse(message, options = {}) {
  return {
    ok: false,
    error: { message, ...(options.code ? { code: options.code } : {}) },
  };
}

export function errorResponseFromException(error) {
  return errorResponse(error instanceof Error ? error.message : String(error));
}

export function serializeResponse(response) {
  return `${JSON.stringify(response)}\n`;
}

export async function dispatchRequest(_backend, _request) {
  throw new CuaHelperError("Computer Use is not available in this build.");
}

export async function handleRequestLine(_backend, _line) {
  throw new CuaHelperError("Computer Use is not available in this build.");
}

export function isBrokerMethod(_method) {
  return false;
}

export function isReadOnlyBrokerMethod(_method) {
  return false;
}
