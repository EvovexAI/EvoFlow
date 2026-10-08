import type { RestrictedCelExpression } from "./parser.js";
import {
  RestrictedCelError,
  type JsonObject,
  type JsonValue,
  type RestrictedCelValue,
} from "./types.js";

export function evaluateRestrictedCel(
  expression: RestrictedCelExpression,
  input: RestrictedCelValue,
): JsonValue {
  assertRestrictedCelValue(input, expression.offset);
  return freezeJson(evaluate(expression, input));
}

function evaluate(expression: RestrictedCelExpression, input: RestrictedCelValue): JsonValue {
  switch (expression.type) {
    case "literal":
      return expression.value;
    case "input":
      return input;
    case "array":
      return expression.elements.map((element) => evaluate(element, input));
    case "object": {
      const result: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
      for (const entry of expression.entries) {
        Object.defineProperty(result, entry.key, {
          configurable: true,
          enumerable: true,
          value: evaluate(entry.value, input),
          writable: true,
        });
      }
      return result;
    }
    case "unary":
      return evaluateUnary(
        expression.operator,
        evaluate(expression.operand, input),
        expression.offset,
      );
    case "binary":
      return evaluateBinary(expression, input);
    case "conditional":
      return requireBoolean(evaluate(expression.condition, input), expression.condition.offset)
        ? evaluate(expression.whenTrue, input)
        : evaluate(expression.whenFalse, input);
  }
}

function evaluateUnary(operator: string, operand: JsonValue, offset: number): JsonValue {
  if (operator === "!") return !requireBoolean(operand, offset);
  const number = requireNumber(operand, offset);
  return assertNumber(operator === "-" ? -number : number, offset);
}

function evaluateBinary(
  expression: Extract<RestrictedCelExpression, { type: "binary" }>,
  input: RestrictedCelValue,
): JsonValue {
  const left = evaluate(expression.left, input);
  if (expression.operator === "&&") {
    return requireBoolean(left, expression.left.offset)
      ? requireBoolean(evaluate(expression.right, input), expression.right.offset)
      : false;
  }
  if (expression.operator === "||") {
    return requireBoolean(left, expression.left.offset)
      ? true
      : requireBoolean(evaluate(expression.right, input), expression.right.offset);
  }

  const right = evaluate(expression.right, input);
  switch (expression.operator) {
    case "==":
      return jsonEquals(left, right);
    case "!=":
      return !jsonEquals(left, right);
    case "+":
      if (typeof left === "string" && typeof right === "string") return left + right;
      return assertNumber(
        requireNumber(left, expression.left.offset) + requireNumber(right, expression.right.offset),
        expression.offset,
      );
    case "-":
      return numericBinary(left, right, expression, (a, b) => a - b);
    case "*":
      return numericBinary(left, right, expression, (a, b) => a * b);
    case "/":
      return numericBinary(left, right, expression, (a, b) => a / b);
    case "%":
      return numericBinary(left, right, expression, (a, b) => a % b);
    case "<":
    case "<=":
    case ">":
    case ">=":
      return compare(left, right, expression.operator, expression.offset);
    default:
      throw new RestrictedCelError(
        `unsupported operator ${expression.operator}`,
        expression.offset,
      );
  }
}

function numericBinary(
  left: JsonValue,
  right: JsonValue,
  expression: Extract<RestrictedCelExpression, { type: "binary" }>,
  operation: (left: number, right: number) => number,
): number {
  return assertNumber(
    operation(
      requireNumber(left, expression.left.offset),
      requireNumber(right, expression.right.offset),
    ),
    expression.offset,
  );
}

function compare(left: JsonValue, right: JsonValue, operator: string, offset: number): boolean {
  if (typeof left !== typeof right || (typeof left !== "number" && typeof left !== "string")) {
    throw new RestrictedCelError(
      "comparison operands must have the same numeric or string type",
      offset,
    );
  }
  const comparison =
    typeof left === "number" && typeof right === "number"
      ? left < right
        ? -1
        : left > right
          ? 1
          : 0
      : String(left) < String(right)
        ? -1
        : String(left) > String(right)
          ? 1
          : 0;
  if (operator === "<") return comparison < 0;
  if (operator === "<=") return comparison <= 0;
  if (operator === ">") return comparison > 0;
  return comparison >= 0;
}

function requireBoolean(value: JsonValue, offset: number): boolean {
  if (typeof value !== "boolean") {
    throw new RestrictedCelError("boolean operand required", offset);
  }
  return value;
}

function requireNumber(value: JsonValue, offset: number): number {
  if (typeof value !== "number") {
    throw new RestrictedCelError("numeric operand required", offset);
  }
  return value;
}

function assertNumber(value: number, offset: number): number {
  if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
    throw new RestrictedCelError("numeric result is not JSON-safe", offset);
  }
  return value;
}

function assertRestrictedCelValue(
  value: unknown,
  offset: number,
): asserts value is RestrictedCelValue {
  if (typeof value === "string") return;
  if (typeof value === "number") {
    assertNumber(value, offset);
    return;
  }
  throw new RestrictedCelError("input value must be a string or number", offset);
}

function jsonEquals(left: JsonValue, right: JsonValue): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((entry, index) => jsonEquals(entry, right[index]!))
    );
  }
  if (isJsonObject(left) && isJsonObject(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every((key) => Object.hasOwn(right, key) && jsonEquals(left[key]!, right[key]!))
    );
  }
  return false;
}

function freezeJson<T extends JsonValue>(value: T): T {
  if (Array.isArray(value)) {
    for (const entry of value) freezeJson(entry);
  } else if (isJsonObject(value)) {
    for (const entry of Object.values(value)) freezeJson(entry);
  } else {
    return value;
  }
  return Object.freeze(value);
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
