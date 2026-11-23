import { Notification } from './Notification'
import { useRef, useState, type ReactNode } from 'react'
import { changeOrderStatus, finishContainerOrder } from '../api'
import { statusLabel } from '../domain'

import { OrderCancellationDialog } from './OrderCancellationDialog'

const statuses = ['DRAFT', 'CONFIRMED', 'COMPLETED']
export function OrderStatusAction({ apiPath, id, status, onChanged, completionAction }: {
  apiPath: string; id: string; status: string; onChanged: (status: string) => void; completionAction?: ReactNode
}) {
  const lock = useRef(false)
  const [cancelling, setCancelling] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const index = statuses.indexOf(status)
  const transport = apiPath === '/api/receiving-orders' || apiPath === '/api/shipping-orders'
  const next = transport && status === 'DRAFT' ? undefined : index >= 0 ? statuses[index + 1] : undefined
  async function advance() {
    if (!next || lock.current) return
    lock.current = true
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const movement = next === 'COMPLETED' && (apiPath === '/api/receiving-orders' || apiPath === '/api/shipping-orders')
      const updated = movement ? await finishContainerOrder(apiPath, id) : await changeOrderStatus(apiPath, id, status, next)
      onChanged(updated.status)
      setMessage(`Статус изменён: ${statusLabel(updated.status)}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось изменить статус')
    } finally {
      lock.current = false
      setBusy(false)
    }
  }
  return <div className="order-status-control">
    {transport && status !== 'CANCELLED' && <button type="button" className="secondary-button" disabled={busy || cancelling} onClick={() => setCancelling(true)}>Отменить заявку</button>}
    {cancelling && <OrderCancellationDialog apiPath={apiPath} id={id} status={status} onChanged={onChanged} onClose={() => setCancelling(false)} />}
    {next === 'COMPLETED' && completionAction ? completionAction : next && <button type="button" className="primary-button" disabled={busy} onClick={advance}>{busy ? 'Сохраняем…' : next === 'CONFIRMED' ? 'Подтвердить' : 'Выполнить'}</button>}
    {error && <Notification kind="error">{error}</Notification>}
    {message && <Notification kind="success">{message}</Notification>}
  </div>
}
