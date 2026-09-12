type Props = {
  id?: string
  className?: string
  value: string
  placeholder?: string
  pickTitle?: string
  onChange: (next: string) => void
}

export function WorkspaceFolderInput({
  id,
  className,
  value,
  placeholder,
  pickTitle = '选择工作目录',
  onChange,
}: Props) {
  const pickFolder = () => {
    void (async () => {
      const mod = await import('../../../lib/workspace-field-ui.js')
      const resolved = await mod.pickResolvedWorkspaceFolder({
        defaultPath: value,
        title: pickTitle,
      })
      if (resolved) onChange(resolved)
    })()
  }

  return (
    <div className="wf-folder-input-row">
      <input
        id={id}
        className={className}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
      <button
        type="button"
        className="wf-folder-input-pick"
        title="选择本机文件夹"
        onClick={pickFolder}
      >
        浏览…
      </button>
    </div>
  )
}
