import type { ReactNode } from 'react'

/** Reveal a registry only when its request has settled, preserving table markup. */
export function TableReveal({ loading, children, className = 'table-card', enabled = true }: {
  loading: boolean; children: ReactNode; className?: string; enabled?: boolean
}) {
  return <div className={className + (enabled ? ' registry-table-reveal' : '')} aria-busy={loading}>
    {children}
    {enabled && loading && <div className="registry-table-loading" role="status">Загружаем данные…</div>}
  </div>
}
