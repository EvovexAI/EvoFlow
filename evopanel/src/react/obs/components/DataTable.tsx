import type { ReactNode } from 'react';

export function DataTable<T extends object>({
  columns,
  rows,
  rowKey,
  onRowClick,
  compact = false
}: {
  columns: Array<{ key: string; label: string; render?: (row: T) => ReactNode }>;
  rows: T[];
  rowKey: (row: T, index: number) => string;
  onRowClick?: (row: T) => void;
  compact?: boolean;
}) {
  return (
    <div className={`obs-table-wrap ${compact ? 'obs-table-wrap--compact' : ''}`}>
      <table className="obs-table">
        <thead>
          <tr>{columns.map((column) => <th key={column.key}>{column.label}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr
              key={rowKey(row, rowIndex)}
              onClick={() => onRowClick?.(row)}
              className={onRowClick ? 'obs-table__row--clickable' : undefined}
            >
              {columns.map((column) => <td key={column.key}>{column.render ? column.render(row) : String((row as Record<string, unknown>)[column.key] ?? '')}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
