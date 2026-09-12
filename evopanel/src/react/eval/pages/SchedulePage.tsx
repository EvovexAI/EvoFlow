import { useState } from 'react'
import { evalApi } from '../api/evalApi'
import { useAsync } from '../hooks/useAsync'

export function SchedulePage() {
  const schedules = useAsync(() => evalApi.schedules(), [])
  const [name, setName] = useState('每日 smoke')
  const list = Array.isArray(schedules.data) ? schedules.data : schedules.data?.schedules || []

  return (
    <>
      <header className="eval-topbar">
        <div>
          <h1>评测计划</h1>
          <p>计划表已落库；调度守护进程后续接入</p>
        </div>
      </header>
      <div className="eval-card">
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={{ flex: 1, padding: 8, borderRadius: 8, border: '1px solid #2a3340', background: '#0f1419', color: '#fff' }}
          />
          <button
            type="button"
            className="eval-btn primary"
            onClick={async () => {
              await evalApi.createSchedule({ name, type: 'smoke', cron: '0 9 * * *' })
              schedules.reload()
            }}
          >
            创建
          </button>
        </div>
        <table className="eval-table">
          <thead>
            <tr>
              <th>名称</th>
              <th>cron</th>
              <th>启用</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.map((s: any) => (
              <tr key={s.id}>
                <td>{s.name}</td>
                <td>{s.cron}</td>
                <td>{s.enabled ? '是' : '否'}</td>
                <td>
                  <button
                    type="button"
                    className="eval-btn"
                    onClick={async () => {
                      await evalApi.toggleSchedule(s.id)
                      schedules.reload()
                    }}
                  >
                    切换
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}
