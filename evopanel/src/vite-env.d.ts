/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_USE_REACT_CHAT?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
