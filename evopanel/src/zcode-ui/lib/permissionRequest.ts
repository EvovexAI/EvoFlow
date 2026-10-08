import { PERMISSION_FULL_ACCESS_OPTION_ID } from "@zcode/shared/zcode-protocol-v4";
import type { ZCodePermissionOption } from "@zcode/shared";

export {
  getPermissionRequestPreview,
  type PermissionRequestFileChange,
  type PermissionRequestPreview,
  type PermissionRequestScope,
} from "@zcode/shared";

type PermissionOptionDisplayKind =
  | "allowOnce"
  | "allowAlways"
  | "rejectOnce"
  | "rejectAlways"
  | "custom";

const GENERIC_PERMISSION_OPTION_NAMES: Record<PermissionOptionDisplayKind, Set<string>> = {
  allowOnce: new Set(["allow", "allow once", "approve"]),
  allowAlways: new Set(["always allow", "allow always", "approve always"]),
  rejectOnce: new Set(["deny", "deny once", "reject", "reject once"]),
  rejectAlways: new Set(["always deny", "deny always", "always reject", "reject always"]),
  custom: new Set(),
};

function normalizeInlineText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export function getPermissionOptionDisplayKind(kind: string): PermissionOptionDisplayKind {
  const normalizedKind = kind.trim().toLowerCase();
  const isAllow = normalizedKind.includes("allow") || normalizedKind.includes("approve");
  const isReject = normalizedKind.includes("reject") || normalizedKind.includes("deny");
  const isAlways = normalizedKind.includes("always");

  if (isAllow && isAlways) {
    return "allowAlways";
  }

  if (isAllow) {
    return "allowOnce";
  }

  if (isReject && isAlways) {
    return "rejectAlways";
  }

  if (isReject) {
    return "rejectOnce";
  }

  return "custom";
}

export function shouldPreferPermissionOptionName(
  option: Pick<ZCodePermissionOption, "kind" | "name">,
): boolean {
  const normalizedName = normalizeInlineText(option.name).toLowerCase();
  if (normalizedName.length === 0) {
    return false;
  }

  const displayKind = getPermissionOptionDisplayKind(option.kind);
  if (displayKind === "custom") {
    return true;
  }

  return !GENERIC_PERMISSION_OPTION_NAMES[displayKind].has(normalizedName);
}

function getPermissionOptionSortPriority(kind: string): number {
  switch (getPermissionOptionDisplayKind(kind)) {
    case "allowOnce":
      return 0;
    case "allowAlways":
      return 1;
    case "rejectOnce":
      return 2;
    case "rejectAlways":
      return 3;
    default:
      return 4;
  }
}

export function sortPermissionOptions(
  options: readonly ZCodePermissionOption[],
): ZCodePermissionOption[] {
  return options
    .map((option, index) => ({ option, index }))
    .sort((left, right) => {
      const priorityDelta =
        (left.option.optionId === PERMISSION_FULL_ACCESS_OPTION_ID
          ? 1.5
          : getPermissionOptionSortPriority(left.option.kind)) -
        (right.option.optionId === PERMISSION_FULL_ACCESS_OPTION_ID
          ? 1.5
          : getPermissionOptionSortPriority(right.option.kind));
      if (priorityDelta !== 0) {
        return priorityDelta;
      }

      return left.index - right.index;
    })
    .map(({ option }) => option);
}
