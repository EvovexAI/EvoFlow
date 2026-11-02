import { assetsHrefForPath, type EvoAssetCitationEntry } from '../lib/evo-asset-citation.js'
import { showRightStageAssetPreview } from '../../lib/right-stage/open-right-stage-file.js'
import { getCurrentRightStageSessionKey } from '../../lib/right-stage/right-stage-scope.js'

type Props = {
  entries: EvoAssetCitationEntry[]
  entityType?: string
  entityId?: string
}

/** Compact chips under an assistant bubble for ``<evo-asset-citation>`` entries. */
export function AssetCitationChips({ entries, entityType, entityId }: Props) {
  if (!entries?.length) return null
  const n = entries.length
  const label = n === 1 ? '引用了 1 条资产' : `引用了 ${n} 条资产`

  return (
    <div className="asset-citation-chips" aria-label={label}>
      <span className="asset-citation-chips__label">{label}</span>
      <ul className="asset-citation-chips__list">
        {entries.map((e) => {
          const name = e.path.split('/').pop() || e.path
          const title = e.note ? `${e.path} — ${e.note}` : e.path
          const href = assetsHrefForPath(e.path, { entityType, entityId })
          return (
            <li key={`${e.path}|${e.note}`}>
              <a
                className="asset-citation-chip"
                href={href}
                title={title}
                onClick={(ev) => {
                  // Primary: right-stage asset preview. Keep href for middle-click / open-in-new.
                  if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey || ev.button !== 0) {
                    return
                  }
                  ev.preventDefault()
                  showRightStageAssetPreview(e.path, {
                    entityType,
                    entityId,
                    name,
                    sessionKey: getCurrentRightStageSessionKey() || undefined,
                  })
                }}
              >
                <span className="asset-citation-chip__path">{name}</span>
                {e.note ? <span className="asset-citation-chip__note">{e.note}</span> : null}
              </a>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
