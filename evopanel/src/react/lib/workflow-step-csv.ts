export function parseCsvField(raw?: string | null): string[] {
  return String(raw || '')
    .split(/[,，;；\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

export function joinCsvField(values: string[]): string | undefined {
  const uniq = [...new Set(values.map((v) => v.trim()).filter(Boolean))]
  return uniq.length ? uniq.join(',') : undefined
}
