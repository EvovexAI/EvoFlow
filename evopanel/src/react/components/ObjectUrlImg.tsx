import { useEffect, useMemo } from 'react'

/** Stable blob URL for a File; revoke only on unmount / file change (never onLoad). */
export function useObjectUrl(file: File | Blob | null | undefined): string {
  const url = useMemo(() => {
    if (!file) return ''
    return URL.createObjectURL(file)
  }, [file])

  useEffect(() => {
    if (!url) return
    return () => {
      URL.revokeObjectURL(url)
    }
  }, [url])

  return url
}

export function ObjectUrlImg({
  file,
  alt,
  className,
}: {
  file: File | Blob
  alt?: string
  className?: string
}) {
  const url = useObjectUrl(file)
  if (!url) return null
  return <img src={url} alt={alt || ''} className={className} />
}
