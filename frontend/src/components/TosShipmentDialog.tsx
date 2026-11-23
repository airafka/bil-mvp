import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { getContainerStock } from '../api'
import { businessDateTimeToInstant, useApplicationClock, businessDateTime } from '../applicationClock'
import { containerTypeLabel, type OrderDetails } from '../domain'
import { request } from '../http'
import { AppOverlay } from './AppOverlay'
import { UiInput } from './FormControls'

type Props = {
  order: OrderDetails
  vehicleNumber?: string | null
  onClose: () => void
  onSent: (container: string) => void
}

export function TosShipmentDialog({ order, vehicleNumber, onClose, onSent }: Props) {
  const { clock, refresh } = useApplicationClock()
  const dialog = useRef<HTMLDialogElement>(null)
  const lock = useRef(false)
  const taskIds = useRef(new Map<string, string>())
  const listId = useId()
  const [number, setNumber] = useState('')
  const [transport, setTransport] = useState(vehicleNumber ?? '')
  const group = order.containerQuantities[0]
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [stock, setStock] = useState<string[]>([])
  const [enteredTime, setTime] = useState<string>()
  const operationTime = enteredTime ?? businessDateTime(clock) + new Date(clock.now).toISOString().slice(16, 23)

  useEffect(() => {
    const element = dialog.current
    element?.showModal()
    void refresh()
    return () => element?.close()
  }, [refresh])

  useEffect(() => {
    let active = true
    const timer = window.setTimeout(() => {
      getContainerStock(number, group?.ownerClientId ?? '', 'ON_TERMINAL').then(page => {
        if (active) setStock(page.items.filter(row => row.containerType === group?.type).map(row => row.containerName))
      }).catch(() => { if (active) setStock([]) })
    }, 150)
    return () => { active = false; window.clearTimeout(timer) }
  }, [number, group?.type, group?.ownerClientId])


  async function submit(event: FormEvent) {
    event.preventDefault()
    if (lock.current) return
    lock.current = true
    setBusy(true)
    setError('')
    try {
      const cargoNumber = number.trim().toUpperCase()
      let taskId = taskIds.current.get(cargoNumber)
      const type = group?.type
      if (!type) throw new Error('В заявке отсутствует плановый типоразмер КТК')
      if (!taskId) {
        const page = await getContainerStock(cargoNumber, group?.ownerClientId ?? '', 'ON_TERMINAL')
        if (!page.items.some(row => row.containerName.toUpperCase() === cargoNumber && row.containerType === type))
          throw new Error('Выберите свободный КТК указанного типоразмера из остатков')
        taskId = crypto.randomUUID()
        taskIds.current.set(cargoNumber, taskId)
      }
      const result = await request<{ status: string; details: string | null }>('/datareon/event', {
        method: 'POST', headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          _id: taskId, _order: order.id, orderNumber: String(order.code), source: 'TOS', site: order.terminalArea.name,
          eventName: 'Погрузка завершена', eventCode: 'LOAD_FINISH', eventDateTime: businessDateTimeToInstant(operationTime),
          cargoResult: [{
            cargoNumber, cargoType: type === 'STANDARD_40' ? 'Контейнер 40' : 'Контейнер 20', qty: 1, active: true,
            transportType: 'АВТО', transportNumber: transport.trim(),
          }],
        }),
      })
      if (result.status !== 'DONE') {
        taskIds.current.delete(cargoNumber)
        throw new Error(result.details ?? 'Обработчик не выполнил пакет TOS')
      }
      onSent(cargoNumber)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось отправить пакет TOS')
    } finally {
      lock.current = false
      setBusy(false)
    }
  }

  return <AppOverlay><dialog ref={dialog} className="route-side-dialog" aria-labelledby={listId + '-title'}
    onCancel={event => { event.preventDefault(); if (!busy) onClose() }}>
    <form onSubmit={submit}>
      <header className="route-dialog-heading"><h2 id={listId + '-title'}>Отправить пакет TOS</h2><div className="header-actions">
        <button type="submit" className="primary-button" disabled={busy || !number.trim() || !transport.trim() || !operationTime}>{busy ? 'Отправляем…' : 'Отправить'}</button>
        <button type="button" className="close-button" aria-label="Закрыть форму пакета" disabled={busy} onClick={onClose}>×</button>
      </div></header>
      <div className="route-drawer-body">
        <p>Пакет зафиксирует вывоз одного КТК по заявке №{order.code}.</p>
        {group && <p>{group.ownerName && group.ownerName + ' · '}{containerTypeLabel(group.type)} · Порожний</p>}
        <label>Номер КТК<UiInput required disabled={busy} list={listId + '-stock'} autoComplete="off" placeholder="Номер КТК из остатков" value={number} onChange={e => setNumber(e.target.value)} /></label>
        <datalist id={listId + '-stock'}>{stock.map(code => <option key={code} value={code} />)}</datalist>
        <label>Номер автомобиля<UiInput required disabled={busy} value={transport} onChange={e => setTransport(e.target.value)} /></label>
        <label>Время вывоза (МСК)<UiInput required type="datetime-local" step="any" disabled={busy} value={operationTime} onChange={e => setTime(e.target.value)} /></label>
        {error && <p className="error-message" role="alert">{error}</p>}
      </div>
    </form>
  </dialog></AppOverlay>
}
