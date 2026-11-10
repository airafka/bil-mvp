import { useEffect, useRef, useState } from 'react'
import { cancelOrder } from '../api'
import { AppOverlay } from './AppOverlay'
import { UiTextarea } from './FormControls'

export function OrderCancellationDialog({ apiPath, id, status, onChanged, onClose }: {
  apiPath: string; id: string; status: string; onChanged: (status: string) => void; onClose: () => void
}) {
  const route = apiPath === '/api/routes'
  const dialog = useRef<HTMLDialogElement>(null)
  const lock = useRef(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { const el = dialog.current; el?.showModal(); el?.querySelector('textarea')?.focus(); return () => el?.close() }, [])
  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (lock.current || !reason.trim()) return
    lock.current = true; setBusy(true); setError('')
    try { const result = await cancelOrder(apiPath, id, status, reason.trim()); onChanged(result.status); onClose() }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось отменить заявку') }
    finally { lock.current = false; setBusy(false) }
  }
  return <AppOverlay><dialog ref={dialog} className="route-side-dialog order-cancellation-dialog" aria-labelledby="cancel-order-title" onCancel={event => { event.preventDefault(); if (!busy) onClose() }}>
    <form onSubmit={submit}>
      <header className="route-dialog-heading"><h2 id="cancel-order-title">{route ? 'Отмена рейса' : 'Отмена заявки'}</h2><div className="header-actions">
        <button type="submit" className="primary-button" disabled={busy || !reason.trim()}>{busy ? 'Отменяем…' : route ? 'Отменить рейс' : 'Отменить заявку'}</button>
        <button type="button" className="close-button" aria-label="Закрыть форму отмены" disabled={busy} onClick={onClose}>×</button>
      </div></header>
      <div className="route-drawer-body">
        <p>{route ? 'Рейс и все его заявки будут отменены одной операцией. Остатки КТК будут восстановлены по каждой заявке.' : status === 'DRAFT' ? 'Черновик будет отменён. Остатки КТК не изменятся.' : apiPath.includes('receiving') ? 'Поставка будет отменена. КТК будут исключены из остатков, прежний собственник восстановлен.' : 'Вывоз будет отменён. КТК снова станут доступны для вывоза.'} Документ и история сохранятся.</p>
        <p>Если есть последующие операции с КТК или начисления в счёте, система покажет, что нужно исправить перед отменой.</p>
        <label className="form-field"><span>Причина отмены *</span><UiTextarea required maxLength={1000} value={reason} disabled={busy} onChange={event => setReason(event.target.value)} autoFocus /></label>
        {error && <p role="alert" className="error-message">{error}</p>}
      </div>
    </form>
  </dialog></AppOverlay>
}
