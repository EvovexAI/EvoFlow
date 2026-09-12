import type { Status } from '../types';

const labelMap: Record<string, string> = {
  success: '成功',
  warning: '警告',
  failed: '失败',
  normal: '正常',
  error: '异常'
};

export function StatusBadge({ status }: { status: Status }) {
  return <span className={`status-badge status-${status}`}>{labelMap[status] ?? status}</span>;
}
