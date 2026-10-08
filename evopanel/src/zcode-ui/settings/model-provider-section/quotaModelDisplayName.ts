export function formatQuotaModelDisplayName(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (/^GLM-\S+$/i.test(compact)) {
    return compact
      .split("-")
      .map((part, index) => {
        if (index === 0) {
          return "GLM";
        }
        if (/^turbo$/i.test(part)) {
          return "Turbo";
        }
        return part;
      })
      .join("-");
  }

  const normalized = compact.replace(/[_-]+/g, " ");
  if (!normalized) {
    return "";
  }

  return normalized
    .split(" ")
    .map((part) => {
      if (/^(GLM|API|MCP|AI)$/i.test(part)) {
        return part.toUpperCase();
      }
      if (/^\d+(\.\d+)?$/.test(part)) {
        return part;
      }
      return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
    })
    .join(" ");
}
