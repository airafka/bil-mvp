import { Notification } from './Notification'
import { useEffect, useRef, useState } from 'react'
import { changeOrderStatus, finishContainerOrder, getOrderCancellation } from '../api'
import { statusLabel } from '../domain'

import { OrderCancellationDialog } from './OrderCancellationDialog'

const statuses = ['DRAFT', 'CONFIRMED', 'COMPLETED']
export function OrderStatusAction({ apiPath, id, status, onChanged }: {
  apiPath: string; id: string; status: string; onChanged: (status: string) => void
}) {
  const lock = useRef(false)
  const [cancelling, setCancelling] = useState(false)
  const [cancelReason, setCancelReason] = useState('')
  useEffect(() => {
    if (status !== 'CANCELLED') return
    let active = true
    getOrderCancellation(apiPath, id).then(value => { if (active) setCancelReason(value.reason) }).catch(() => {})
    return () => { active = false }
  }, [apiPath, id, status])
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
    {status === 'CANCELLED' && cancelReason && <span className="order-cancellation-reason" title={cancelReason}>Причина отмены: {cancelReason}</span>}
    {next && <button type="button" className="primary-button" disabled={busy} onClick={advance}>{busy ? 'Сохраняем…' : next === 'CONFIRMED' ? 'Подтвердить' : 'Выполнить'}</button>}
    {error && <Notification kind="error">{error}</Notification>}
    {message && <Notification kind="success">{message}</Notification>}
  </div>
}
