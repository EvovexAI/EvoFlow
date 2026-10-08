import { evaluateRestrictedCel } from "./evaluator.js";
import { parseRestrictedCel, type RestrictedCelExpression } from "./parser.js";
import { tokenizeRestrictedCel } from "./tokenizer.js";
import {
  RestrictedCelError,
  type JsonObject,
  type ModelOptionName,
  type ModelOptionMapProgram,
  type RestrictedCelProgram,
  type RestrictedCelValue,
} from "./types.js";

const programCache = new Map<string, RestrictedCelProgram>();
const optionMapCache = new Map<string, ModelOptionMapProgram>();
const expressionCache = new Map<string, RestrictedCelExpression>();

export function compileRestrictedCel(
  source: string,
  variableName: ModelOptionName,
): RestrictedCelProgram {
  const normalizedSource = normalizeSource(source);
  const cacheKey = createCacheKey(normalizedSource, variableName);
  const cached = programCache.get(cacheKey);
  if (cached) return cached;

  const expression = parseExpression(normalizedSource, variableName);
  const program: RestrictedCelProgram = Object.freeze({
    source: normalizedSource,
    evaluate: (input: RestrictedCelValue) => evaluateRestrictedCel(expression, input),
  });
  programCache.set(cacheKey, program);
  return program;
}

export function compileModelOptionMap(
  source: string,
  variableName: ModelOptionName,
): ModelOptionMapProgram {
  const normalizedSource = normalizeSource(source);
  const cacheKey = createCacheKey(normalizedSource, variableName);
  const cached = optionMapCache.get(cacheKey);
  if (cached) return cached;
  const expression = parseExpression(normalizedSource, variableName);
  assertObjectResultExpression(expression);
  const program: ModelOptionMapProgram = Object.freeze({
    source: normalizedSource,
    evaluate(input: RestrictedCelValue): JsonObject {
      const result = evaluateRestrictedCel(expression, input);
      if (!isJsonObject(result)) {
        throw new RestrictedCelError("model option map must return a JSON object", 0);
      }
      return result;
    },
  });
  optionMapCache.set(cacheKey, program);
  return program;
}

function normalizeSource(source: string): string {
  const normalizedSource = source.trim();
  if (normalizedSource.length === 0) {
    throw new RestrictedCelError("expression must not be empty", 0);
  }
  return normalizedSource;
}

function parseExpression(source: string, variableName: ModelOptionName): RestrictedCelExpression {
  const cacheKey = createCacheKey(source, variableName);
  const cached = expressionCache.get(cacheKey);
  if (cached) return cached;
  const expression = parseRestrictedCel(tokenizeRestrictedCel(source), variableName);
  expressionCache.set(cacheKey, expression);
  return expression;
}

function createCacheKey(source: string, variableName: ModelOptionName): string {
  return `${variableName}\0${source}`;
}

function assertObjectResultExpression(expression: RestrictedCelExpression): void {
  if (expression.type === "object") return;
  if (expression.type === "conditional") {
    assertObjectResultExpression(expression.whenTrue);
    assertObjectResultExpression(expression.whenFalse);
    return;
  }
  throw new RestrictedCelError("model option map must return a JSON object", expression.offset);
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
