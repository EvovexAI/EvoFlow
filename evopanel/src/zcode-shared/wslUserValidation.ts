import { z } from "zod";

export const WSL_USER_MAX_LENGTH = 64;

export function isValidWslUser(value: string): boolean {
  const user = value.trim();
  return (
    user.length > 0 &&
    user.length <= WSL_USER_MAX_LENGTH &&
    !containsControlCharacter(user) &&
    !user.includes(":") &&
    !user.includes("/") &&
    !user.includes("\\")
  );
}

function containsControlCharacter(value: string): boolean {
  for (const char of value) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (codePoint < 32 || codePoint === 127) {
      return true;
    }
  }
  return false;
}

export const wslUserSchema = z
  .string()
  .trim()
  .max(WSL_USER_MAX_LENGTH)
  .refine((value) => value.length === 0 || isValidWslUser(value), {
    message: "Invalid WSL user",
  });
