import { RestrictedCelError, type ModelOptionName } from "./types.js";
import type { RestrictedCelToken } from "./tokenizer.js";

export type RestrictedCelExpression =
  | {
      readonly type: "literal";
      readonly value: string | number | boolean | null;
      readonly offset: number;
    }
  | { readonly type: "input"; readonly offset: number }
  | {
      readonly type: "array";
      readonly elements: readonly RestrictedCelExpression[];
      readonly offset: number;
    }
  | {
      readonly type: "object";
      readonly entries: readonly {
        readonly key: string;
        readonly value: RestrictedCelExpression;
        readonly offset: number;
      }[];
      readonly offset: number;
    }
  | {
      readonly type: "unary";
      readonly operator: "!" | "-" | "+";
      readonly operand: RestrictedCelExpression;
      readonly offset: number;
    }
  | {
      readonly type: "binary";
      readonly operator: string;
      readonly left: RestrictedCelExpression;
      readonly right: RestrictedCelExpression;
      readonly offset: number;
    }
  | {
      readonly type: "conditional";
      readonly condition: RestrictedCelExpression;
      readonly whenTrue: RestrictedCelExpression;
      readonly whenFalse: RestrictedCelExpression;
      readonly offset: number;
    };

export function parseRestrictedCel(
  tokens: readonly RestrictedCelToken[],
  variableName: ModelOptionName,
): RestrictedCelExpression {
  return new Parser(tokens, variableName).parse();
}

class Parser {
  #index = 0;

  constructor(
    private readonly tokens: readonly RestrictedCelToken[],
    private readonly variableName: ModelOptionName,
  ) {}

  parse(): RestrictedCelExpression {
    const expression = this.parseConditional();
    const trailing = this.current();
    if (trailing.kind !== "eof") {
      if (trailing.value === ".") {
        throw new RestrictedCelError("member access is not supported", trailing.offset);
      }
      if (trailing.value === "(") {
        throw new RestrictedCelError("function calls are not supported", trailing.offset);
      }
      throw new RestrictedCelError(
        `unexpected token ${JSON.stringify(trailing.value)}`,
        trailing.offset,
      );
    }
    return expression;
  }

  private parseConditional(): RestrictedCelExpression {
    const condition = this.parseLogicalOr();
    if (!this.consume("?")) return condition;
    const whenTrue = this.parseConditional();
    this.expect(":");
    const whenFalse = this.parseConditional();
    return { type: "conditional", condition, whenTrue, whenFalse, offset: condition.offset };
  }

  private parseLogicalOr(): RestrictedCelExpression {
    return this.parseBinary(() => this.parseLogicalAnd(), new Set(["||"]));
  }

  private parseLogicalAnd(): RestrictedCelExpression {
    return this.parseBinary(() => this.parseEquality(), new Set(["&&"]));
  }

  private parseEquality(): RestrictedCelExpression {
    return this.parseBinary(() => this.parseRelational(), new Set(["==", "!="]));
  }

  private parseRelational(): RestrictedCelExpression {
    return this.parseBinary(() => this.parseAdditive(), new Set(["<", "<=", ">", ">="]));
  }

  private parseAdditive(): RestrictedCelExpression {
    return this.parseBinary(() => this.parseMultiplicative(), new Set(["+", "-"]));
  }

  private parseMultiplicative(): RestrictedCelExpression {
    return this.parseBinary(() => this.parseUnary(), new Set(["*", "/", "%"]));
  }

  private parseBinary(
    parseOperand: () => RestrictedCelExpression,
    operators: ReadonlySet<string>,
  ): RestrictedCelExpression {
    let expression = parseOperand();
    while (this.current().kind === "operator" && operators.has(this.current().value)) {
      const operator = this.advance();
      expression = {
        type: "binary",
        operator: operator.value,
        left: expression,
        right: parseOperand(),
        offset: operator.offset,
      };
    }
    return expression;
  }

  private parseUnary(): RestrictedCelExpression {
    const token = this.current();
    if (
      token.kind === "operator" &&
      (token.value === "!" || token.value === "-" || token.value === "+")
    ) {
      this.advance();
      return {
        type: "unary",
        operator: token.value,
        operand: this.parseUnary(),
        offset: token.offset,
      };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): RestrictedCelExpression {
    const token = this.advance();
    if (token.kind === "number") {
      const value = Number(token.value);
      if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
        throw new RestrictedCelError("number literal is not JSON-safe", token.offset);
      }
      return { type: "literal", value, offset: token.offset };
    }
    if (token.kind === "string")
      return { type: "literal", value: token.value, offset: token.offset };
    if (token.kind === "identifier") {
      if (this.current().value === "(") {
        throw new RestrictedCelError("function calls are not supported", this.current().offset);
      }
      if (token.value === this.variableName) return { type: "input", offset: token.offset };
      if (token.value === "true" || token.value === "false") {
        return { type: "literal", value: token.value === "true", offset: token.offset };
      }
      if (token.value === "null") return { type: "literal", value: null, offset: token.offset };
      throw new RestrictedCelError(
        `unknown identifier ${JSON.stringify(token.value)}`,
        token.offset,
      );
    }
    if (token.value === "(") {
      const expression = this.parseConditional();
      this.expect(")");
      return expression;
    }
    if (token.value === "[") return this.parseArray(token.offset);
    if (token.value === "{") return this.parseObject(token.offset);
    throw new RestrictedCelError(`unexpected token ${JSON.stringify(token.value)}`, token.offset);
  }

  private parseArray(offset: number): RestrictedCelExpression {
    const elements: RestrictedCelExpression[] = [];
    if (!this.consume("]")) {
      do elements.push(this.parseConditional());
      while (this.consume(","));
      this.expect("]");
    }
    return { type: "array", elements: Object.freeze(elements), offset };
  }

  private parseObject(offset: number): RestrictedCelExpression {
    const entries: { key: string; value: RestrictedCelExpression; offset: number }[] = [];
    const keys = new Set<string>();
    if (!this.consume("}")) {
      do {
        const key = this.advance();
        if (key.kind !== "string") {
          throw new RestrictedCelError("object keys must be string literals", key.offset);
        }
        if (keys.has(key.value)) {
          throw new RestrictedCelError(
            `duplicate object key ${JSON.stringify(key.value)}`,
            key.offset,
          );
        }
        keys.add(key.value);
        this.expect(":");
        entries.push({ key: key.value, value: this.parseConditional(), offset: key.offset });
      } while (this.consume(","));
      this.expect("}");
    }
    return { type: "object", entries: Object.freeze(entries), offset };
  }

  private consume(value: string): boolean {
    if (this.current().value !== value) return false;
    this.#index += 1;
    return true;
  }

  private expect(value: string): RestrictedCelToken {
    const token = this.current();
    if (token.value !== value) {
      throw new RestrictedCelError(`expected ${JSON.stringify(value)}`, token.offset);
    }
    this.#index += 1;
    return token;
  }

  private advance(): RestrictedCelToken {
    const token = this.current();
    if (token.kind !== "eof") this.#index += 1;
    return token;
  }

  private current(): RestrictedCelToken {
    return this.tokens[this.#index] ?? this.tokens[this.tokens.length - 1]!;
  }
}
