import * as React from 'react'
import { cn } from '@/lib/utils'

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: 'default' | 'success' | 'warning' | 'danger' | 'secondary'
}

function Badge({ className, variant = 'default', ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium',
        variant === 'default' && 'bg-[var(--accent)] text-[var(--accent-foreground)]',
        variant === 'success' && 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
        variant === 'warning' && 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
        variant === 'danger' && 'bg-red-500/10 text-red-600 dark:text-red-400',
        variant === 'secondary' && 'bg-[var(--secondary)] text-[var(--secondary-foreground)]',
        className,
      )}
      {...props}
    />
  )
}

export { Badge }
