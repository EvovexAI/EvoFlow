export interface IndexHit {
  path: string
  snippet: string | null
  kind: string | null
}

export interface IndexSymbol {
  path: string
  name: string
  kind: string
  line: number
}

export interface IndexRelation {
  from_path: string
  to_path: string
  kind: string
  symbol?: string
  line?: number
}

export interface IndexSearchResponse {
  query: string
  hits: IndexHit[]
  symbols: IndexSymbol[]
  related_files?: IndexHit[]
  imported_by?: IndexRelation[]
  imports?: IndexRelation[]
  internal_ref_users?: IndexRelation[]
  type_supertypes?: IndexRelation[]
  type_subtypes?: IndexRelation[]
  ready?: boolean | null
  building?: boolean | null
  rebuild_in_progress?: boolean | null
  message?: string | null
}

export type CodeIndexStatus = {
  ok?: boolean
  ready?: boolean
  building?: boolean
  files?: number
  symbols?: number
  root?: string
  db_path?: string
  status?: string
  build_total_files?: number
  build_indexed_files?: number
  build_progress_pct?: number
  build_phase?: string
  /** ISO UTC from index DB mtime */
  updated_at?: string | null
}
