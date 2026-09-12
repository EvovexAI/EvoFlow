import type { ReactNode } from 'react';
import type { NavKey } from '../types';
import { Sidebar } from './Sidebar';

export function Shell({ active, onChange, children }: { active: NavKey; onChange: (key: NavKey) => void; children: ReactNode }) {
  return (
    <div className="app-shell">
      <Sidebar active={active} onChange={onChange} />
      <main className="main-panel">{children}</main>
    </div>
  );
}
