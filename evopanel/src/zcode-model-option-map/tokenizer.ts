import { RestrictedCelError } from "./types.js";

export type RestrictedCelTokenKind =
  | "identifier"
  | "string"
  | "number"
  | "operator"
  | "punctuation"
  | "eof";

export interface RestrictedCelToken {
  readonly kind: RestrictedCelTokenKind;
  readonly value: string;
  readonly offset: number;
  readonly end: number;
}

const DOUBLE_OPERATORS = new Set(["&&", "||", "==", "!=", "<=", ">="]);
const SINGLE_OPERATORS = new Set(["+", "-", "*", "/", "%", "!", "<", ">"]);
const PUNCTUATION = new Set(["{", "}", "[", "]", "(", ")", ",", ":", "?", "."]);

export function tokenizeRestrictedCel(source: string): readonly RestrictedCelToken[] {
  const tokens: RestrictedCelToken[] = [];
  let offset = 0;
  while (offset < source.length) {
    const character = source[offset]!;
    if (/\s/u.test(character)) {
      offset += 1;
      continue;
    }

    if (character === "'" || character === '"') {
      const token = readString(source, offset, character);
      tokens.push(token);
      offset = token.end;
      continue;
    }

    if (/[0-9]/u.test(character)) {
      const token = readNumber(source, offset);
      tokens.push(token);
      offset = token.end;
      continue;
    }

    if (/[A-Za-z_]/u.test(character)) {
      const end = readWhile(source, offset + 1, /[A-Za-z0-9_]/u);
      tokens.push({ kind: "identifier", value: source.slice(offset, end), offset, end });
      offset = end;
      continue;
    }

    const pair = source.slice(offset, offset + 2);
    if (DOUBLE_OPERATORS.has(pair)) {
      tokens.push({ kind: "operator", value: pair, offset, end: offset + 2 });
      offset += 2;
      continue;
    }
    if (SINGLE_OPERATORS.has(character)) {
      tokens.push({ kind: "operator", value: character, offset, end: offset + 1 });
      offset += 1;
      continue;
    }
    if (PUNCTUATION.has(character)) {
      tokens.push({ kind: "punctuation", value: character, offset, end: offset + 1 });
      offset += 1;
      continue;
    }
    throw new RestrictedCelError(`unsupported token ${JSON.stringify(character)}`, offset);
  }
  tokens.push({ kind: "eof", value: "", offset: source.length, end: source.length });
  return Object.freeze(tokens);
}

function readNumber(source: string, offset: number): RestrictedCelToken {
  const match = /^(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(source.slice(offset));
  if (!match) throw new RestrictedCelError("invalid number literal", offset);
  const value = match[0];
  const end = offset + value.length;
  return { kind: "number", value, offset, end };
}

function readString(source: string, offset: number, quote: "'" | '"'): RestrictedCelToken {
  let cursor = offset + 1;
  let value = "";
  while (cursor < source.length) {
    const character = source[cursor]!;
    if (character === quote) {
      return { kind: "string", value, offset, end: cursor + 1 };
    }
    if (character === "\n" || character === "\r") {
      throw new RestrictedCelError("unterminated string literal", offset);
    }
    if (character !== "\\") {
      value += character;
      cursor += 1;
      continue;
    }

    const escapeOffset = cursor;
    cursor += 1;
    const escaped = source[cursor];
    if (escaped === undefined) {
      throw new RestrictedCelError("unterminated string escape", escapeOffset);
    }
    const simpleEscape = SIMPLE_ESCAPES[escaped];
    if (simpleEscape !== undefined) {
      value += simpleEscape;
      cursor += 1;
      continue;
    }
    if (escaped === "u") {
      const digits = source.slice(cursor + 1, cursor + 5);
      if (!/^[0-9A-Fa-f]{4}$/u.test(digits)) {
        throw new RestrictedCelError("invalid unicode escape", escapeOffset);
      }
      value += String.fromCharCode(Number.parseInt(digits, 16));
      cursor += 5;
      continue;
    }
    throw new RestrictedCelError(`unsupported string escape \\${escaped}`, escapeOffset);
  }
  throw new RestrictedCelError("unterminated string literal", offset);
}

const SIMPLE_ESCAPES: Readonly<Record<string, string>> = Object.freeze({
  "'": "'",
  '"': '"',
  "\\": "\\",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
});

function readWhile(source: string, offset: number, pattern: RegExp): number {
  let cursor = offset;
  while (cursor < source.length && pattern.test(source[cursor]!)) cursor += 1;
  return cursor;
}
