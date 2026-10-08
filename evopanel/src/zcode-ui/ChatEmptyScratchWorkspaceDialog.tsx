export function getScratchWorkspaceLocationHint(name: string) {
  return `~/ZCodeProject/${name.trim()}`;
}

export function getScratchWorkspaceNameErrorKind(name: string) {
  const trimmedName = name.trim();
  if (!trimmedName) {
    return "required";
  }

  if (/[\\/]/.test(trimmedName)) {
    return "separator";
  }

  return null;
}
