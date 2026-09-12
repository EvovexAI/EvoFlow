import type { ReactNode } from 'react'

/**
 * Shared folder-tree icons (same SVG set as knowledge vault browse panel).
 */
export function KvFolderIcon({
  name,
  size = 15,
}: {
  name: 'folder' | 'folder-open' | 'file' | 'chevron' | 'search' | 'close' | 'refresh' | 'plus'
  size?: number
}) {
  const paths: Record<string, ReactNode> = {
    folder: (
      <>
        <path d="M3 6.5h6l2 2h10v9.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6.5Z" />
        <path d="M3 10h18" />
      </>
    ),
    'folder-open': (
      <>
        <path d="M3 7.5h6.2l1.6 1.8H21v9.2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7.5Z" />
        <path d="M3 11.2 5.2 18h13.6L21 11.2" />
      </>
    ),
    file: (
      <>
        <path d="M6 2h8l4 4v16H6V2Z" />
        <path d="M14 2v5h5M9 12h6M9 16h6" />
      </>
    ),
    chevron: <path d="m9 6 6 6-6 6" />,
    search: (
      <>
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-4-4" />
      </>
    ),
    close: <path d="M6 6l12 12M18 6 6 18" />,
    refresh: (
      <>
        <path d="M20 11a8 8 0 1 0 2 5.3" />
        <path d="M20 4v7h-7" />
      </>
    ),
    plus: <path d="M12 5v14M5 12h14" />,
  }

  return (
    <svg
      aria-hidden="true"
      className="kv-icon"
      fill="none"
      height={size}
      viewBox="0 0 24 24"
      width={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
    >
      {paths[name] || paths.file}
    </svg>
  )
}

/** Filled caret — stroke chevrons are easy to lose on glass / low-contrast panels. */
export function KvTreeCaret({ open, size = 14 }: { open: boolean; size?: number }) {
  return open ? (
    <svg
      aria-hidden="true"
      className="kv-icon kv-icon--caret"
      fill="currentColor"
      height={size}
      viewBox="0 0 12 12"
      width={size}
    >
      <path d="M9.924 3.958a.6.6 0 0 1 0 .847L7.299 7.43a1.836 1.836 0 0 1-2.598 0L2.076 4.805a.599.599 0 1 1 .848-.847l2.625 2.625a.64.64 0 0 0 .902 0l2.625-2.625a.6.6 0 0 1 .848 0" />
    </svg>
  ) : (
    <svg
      aria-hidden="true"
      className="kv-icon kv-icon--caret"
      fill="currentColor"
      height={size}
      viewBox="0 0 12 12"
      width={size}
    >
      <path d="M7.761 7.052a1.425 1.425 0 0 0 0-2.015L4.844 2.12a.599.599 0 1 0-.847.847l2.916 2.917a.225.225 0 0 1 0 .319L3.997 9.12a.599.599 0 1 0 .847.847z" />
    </svg>
  )
}
