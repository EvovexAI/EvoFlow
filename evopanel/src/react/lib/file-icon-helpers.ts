const DEFAULT_FILE_ICON_NAME = 'document'

const FILE_NAME_ICON_ALIASES: Record<string, string> = {
  '.editorconfig': 'editorconfig',
  '.env': 'settings',
  '.gitattributes': 'git',
  '.gitignore': 'git',
  '.npmrc': 'npm',
  '.nvmrc': 'nodejs_alt',
  '.prettierrc': 'prettier',
  '.yarnrc': 'yarn',
  'babel.config': 'babel',
  bun: 'lock',
  'bun.lock': 'lock',
  cargo: 'rust',
  'cargo.lock': 'lock',
  dockerfile: 'docker',
  eslint: 'eslint',
  'eslint.config': 'eslint',
  gemfile: 'gemfile',
  jest: 'jest',
  'jest.config': 'jest',
  makefile: 'makefile',
  'package-lock': 'lock',
  'pnpm-lock': 'lock',
  readme: 'readme',
  tsconfig: 'tsconfig',
  vitest: 'vitest',
  'vitest.config': 'vitest',
  yarn: 'yarn',
}

const EXTENSION_ICON_ALIASES: Record<string, string> = {
  backup: 'document',
  bash: 'console',
  cjs: 'javascript',
  cts: 'typescript',
  css: 'css',
  doc: 'word',
  docx: 'word',
  go: 'go',
  html: 'html',
  java: 'java',
  jpeg: 'image',
  jpg: 'image',
  js: 'javascript',
  jsx: 'react',
  json: 'json',
  jsonl: 'json',
  mjs: 'javascript',
  md: 'markdown',
  m4a: 'audio',
  m4v: 'video',
  flac: 'audio',
  mov: 'video',
  mp3: 'audio',
  mp4: 'video',
  ogg: 'audio',
  opus: 'audio',
  mts: 'typescript',
  pdf: 'pdf',
  php: 'php',
  png: 'image',
  pptx: 'powerpoint',
  py: 'python',
  responses: 'json',
  rs: 'rust',
  sb: 'storybook',
  sql: 'database',
  sh: 'console',
  snap: 'snapcraft',
  svg: 'svg',
  toml: 'toml',
  ts: 'typescript',
  tsx: 'react_ts',
  txt: 'document',
  wav: 'audio',
  weba: 'audio',
  webm: 'video',
  xlsx: 'table',
  yaml: 'yaml',
  yml: 'yaml',
  zsh: 'console',
}

export function resolveFileIconName(filePath: string): string {
  const normalizedPath = String(filePath || '').replace(/\\/g, '/')
  const lastSlash = normalizedPath.lastIndexOf('/')
  const leaf = lastSlash === -1 ? normalizedPath : normalizedPath.slice(lastSlash + 1)
  const normalizedLeaf = leaf.toLowerCase()
  const lastDot = leaf.lastIndexOf('.')
  const fileNameWithoutExtension =
    lastDot === -1 ? normalizedLeaf : normalizedLeaf.slice(0, lastDot)

  const fileNameAliasCandidates = new Set<string>([normalizedLeaf, fileNameWithoutExtension])
  let stemCandidate = fileNameWithoutExtension
  while (stemCandidate.includes('.')) {
    stemCandidate = stemCandidate.slice(0, stemCandidate.lastIndexOf('.'))
    if (stemCandidate) {
      fileNameAliasCandidates.add(stemCandidate)
    }
  }

  for (const candidate of fileNameAliasCandidates) {
    const aliasedFileName = FILE_NAME_ICON_ALIASES[candidate]
    if (aliasedFileName) {
      return aliasedFileName
    }
  }

  if (lastDot === -1) {
    return DEFAULT_FILE_ICON_NAME
  }

  const extension = leaf.slice(lastDot + 1).toLowerCase()
  return EXTENSION_ICON_ALIASES[extension] ?? extension ?? DEFAULT_FILE_ICON_NAME
}

function resolveMaterialIconBasePath(): string {
  const baseUrl =
    typeof import.meta !== 'undefined' && typeof (import.meta as any).env?.BASE_URL === 'string'
      ? (import.meta as any).env.BASE_URL
      : '/'
  return `${baseUrl.replace(/\/?$/, '/')}material-icons`
}

export function buildFileIconSrc(iconName: string): string {
  return `${resolveMaterialIconBasePath()}/${iconName}.svg`
}

export function resolveFileIconSrc(filePath: string): string {
  return buildFileIconSrc(resolveFileIconName(filePath))
}