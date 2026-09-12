import type { ReactNode } from 'react';
import type { DataSource } from '../types';

/** 数据来源角标：真实数据 / 演示数据 */
export function DataSourceBadge({ source }: { source: DataSource | null }) {
  if (!source) return null;
  return (
    <span className={`data-source-badge ${source === 'live' ? 'live' : 'demo'}`}>
      {source === 'live' ? '真实数据' : '演示数据'}
    </span>
  );
}

/** 加载骨架屏 */
export function LoadingBlock({ rows = 3, className = 'span-3' }: { rows?: number; className?: string }) {
  return (
    <div className={`card ${className}`}>
      <div className="skeleton-list">
        {Array.from({ length: rows }).map((_, i) => (
          <div className="skeleton-row" key={i}><i /><i /><i /></div>
        ))}
      </div>
    </div>
  );
}

/** 空状态 */
export function EmptyState({ title = '暂无数据', hint }: { title?: string; hint?: string }) {
  return (
    <div className="placeholder-card">
      <div className="placeholder-icon">📭</div>
      <h3>{title}</h3>
      {hint && <p>{hint}</p>}
    </div>
  );
}

/** 错误提示 */
export function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className={`card span-3`}>
      <div className="error-banner">
        <span>⚠️</span>
        <p>数据加载失败：{message}</p>
        {onRetry && <button onClick={onRetry}>重试</button>}
      </div>
    </div>
  );
}

/** 通用弹窗 */
export function Modal({
  title,
  children,
  onClose,
  footer
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  footer?: ReactNode;
}) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{title}</h3>
          <button className="icon-button" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}

/** 状态映射工具 */
export const levelLabel: Record<string, string> = {
  high: '高危',
  medium: '中危',
  low: '低危',
  critical: '严重',
  warning: '警告',
  info: '提示'
};

export const levelClass: Record<string, string> = {
  high: 'level-high',
  medium: 'level-medium',
  low: 'level-low'
};

export const levelIcon: Record<string, string> = {
  high: '🔴',
  medium: '🟡',
  low: '🟢',
  info: '🔵'
};
