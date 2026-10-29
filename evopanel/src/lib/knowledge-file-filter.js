/**
 * Client-side mirror of backend owned KB skip rules
 * (`evoflow.knowledge.owned.formats.should_skip_file`).
 * Used for folder pick upload + V4 file-tree filtering.
 */

const SUPPORTED_EXTENSIONS = new Set([
  '.md',
  '.markdown',
  '.mdx',
  '.txt',
  '.log',
  '.csv',
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.xml',
  '.html',
  '.htm',
  '.pdf',
  '.doc',
  '.docx',
  '.ppt',
  '.pptx',
  '.xls',
  '.xlsx',
])

const ARCHIVE_EXTENSIONS = new Set([
  '.zip',
  '.rar',
  '.7z',
  '.tar',
  '.gz',
  '.tgz',
  '.bz2',
  '.xz',
  '.cab',
  '.iso',
])

const IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.svg',
  '.ico',
  '.tif',
  '.tiff',
  '.heic',
  '.avif',
])

const CODE_EXTENSIONS = new Set([
  '.py',
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.java',
  '.go',
  '.rs',
  '.c',
  '.cpp',
  '.h',
  '.hpp',
  '.cs',
  '.rb',
  '.php',
  '.swift',
  '.kt',
  '.scala',
  '.sh',
  '.bash',
  '.zsh',
  '.ps1',
  '.bat',
  '.cmd',
  '.ini',
  '.cfg',
  '.conf',
  '.css',
  '.scss',
  '.less',
  '.vue',
  '.svelte',
])

const IGNORE_DIR_NAMES = new Set([
  '.git',
  '.svn',
  '.hg',
  'node_modules',
  '__pycache__',
  '.obsidian',
  '.trash',
  '.smart-env',
  '.venv',
  'venv',
])

const IGNORE_FILE_NAMES = new Set(['Thumbs.db', '.DS_Store', 'desktop.ini'])

const TEMP_SUFFIXES = ['.tmp', '.temp', '.swp', '.swo', '.bak', '.crdownload', '.partial', '.part']

function fileBaseName(name) {
  const s = String(name || '').replace(/\\/g, '/')
  const i = s.lastIndexOf('/')
  return i >= 0 ? s.slice(i + 1) : s
}

function extOf(name) {
  const base = fileBaseName(name).toLowerCase()
  const i = base.lastIndexOf('.')
  return i >= 0 ? base.slice(i) : ''
}

export function isSupportedKnowledgeFile(name) {
  return SUPPORTED_EXTENSIONS.has(extOf(name))
}

/** @param {string} name file name or relative path */
export function shouldSkipKnowledgeFile(name) {
  const base = fileBaseName(name)
  if (!base || IGNORE_FILE_NAMES.has(base)) return true
  if (base.startsWith('.')) return true
  if (base.startsWith('.~') || base.startsWith('~$') || base.startsWith('~') || base.endsWith('~')) {
    return true
  }
  const lower = base.toLowerCase()
  const suffix = extOf(lower)
  if (ARCHIVE_EXTENSIONS.has(suffix) || IMAGE_EXTENSIONS.has(suffix) || CODE_EXTENSIONS.has(suffix)) {
    return true
  }
  if (TEMP_SUFFIXES.some((ext) => lower.endsWith(ext))) return true
  return !isSupportedKnowledgeFile(base)
}

/** Hidden / ignored directories (leading "." or known junk like node_modules). */
export function shouldSkipKnowledgeDir(name) {
  const base = fileBaseName(name)
  if (!base) return true
  return IGNORE_DIR_NAMES.has(base) || base.startsWith('.')
}

/** True if any path segment is a hidden / ignored dir, or the leaf file is skipped. */
export function shouldSkipKnowledgeRelPath(relPath) {
  const parts = String(relPath || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
  if (parts.length === 0) return true
  for (const part of parts.slice(0, -1)) {
    if (shouldSkipKnowledgeDir(part)) return true
  }
  return shouldSkipKnowledgeFile(parts[parts.length - 1])
}

export function folderPathFromRelative(relPath) {
  const parts = String(relPath || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
  if (parts.length <= 1) return ''
  return parts.slice(0, -1).join('/')
}
