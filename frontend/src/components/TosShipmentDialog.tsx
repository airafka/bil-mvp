import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { getContainerStock, lookupContainerStock } from '../api'
import { businessDateTimeToInstant, useApplicationClock, businessDateTime } from '../applicationClock'
import type { StockOwner } from '../containerStock'
import { containerTypeLabel, type OrderDetails, type PagedResponse } from '../domain'
import { request } from '../http'
import { AppOverlay } from './AppOverlay'
import { UiInput } from './FormControls'

type Props = {
  order: OrderDetails
  vehicleNumber?: string | null
  onClose: () => void
  onSent: (container: string) => void
}

type StockFilter = { query: string; page: number }
type StockResult = { filter: StockFilter; data: PagedResponse<StockOwner> } | { filter: StockFilter; error: string }

export function TosShipmentDialog({ order, vehicleNumber, onClose, onSent }: Props) {
  const { clock, refresh } = useApplicationClock()
  const dialog = useRef<HTMLDialogElement>(null)
  const lock = useRef(false)
  const taskIds = useRef(new Map<string, string>())
  const listId = useId()
  const [selectedId, setSelectedId] = useState('')
  const [filter, setFilter] = useState<StockFilter>({ query: '', page: 0 })
  const [stockResult, setStockResult] = useState<StockResult | null>(null)
  const [transport, setTransport] = useState(vehicleNumber ?? '')
  const group = order.containerQuantities[0]
  const owner = group?.ownerClientId
  const type = group?.type
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [enteredTime, setTime] = useState<string>()
  const operationTime = enteredTime ?? businessDateTime(clock) + new Date(clock.now).toISOString().slice(16, 23)
  const result = stockResult?.filter === filter ? stockResult : null
  const stock = result && 'data' in result ? result.data : null
  const selected = stock?.items.find(row => row.containerId === selectedId)

  useEffect(() => {
    const element = dialog.current
    element?.showModal()
    void refresh()
    return () => element?.close()
  }, [refresh])

  useEffect(() => {
    if (!type) return
    let active = true
    const timer = window.setTimeout(() => {
      getContainerStock(filter.query.trim(), owner ?? '', 'ON_TERMINAL', filter.page, type).then(data => {
        if (!active) return
        if (filter.page > 0 && filter.page >= data.totalPages) {
          setFilter({ ...filter, page: Math.max(0, data.totalPages - 1) })
          return
        }
        setStockResult({ filter, data })
      }).catch(cause => {
        if (active) setStockResult({ filter, error: cause instanceof Error ? cause.message : 'Не удалось загрузить остатки' })
      })
    }, 150)
    return () => { active = false; window.clearTimeout(timer) }
  }, [filter, owner, type])

  function changeFilter(query: string, page: number) {
    setSelectedId('')
    setError('')
    setFilter({ query, page })
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (lock.current || !selected || !type) return
    lock.current = true
    setBusy(true)
    setError('')
    try {
      const cargoNumber = selected.containerName
      let taskId = taskIds.current.get(cargoNumber)
      if (!taskId) {
        const [current] = await lookupContainerStock([selected.containerId])
        if (current?.status !== 'ON_TERMINAL' || (owner && current.ownerClientId !== owner)) {
          changeFilter(filter.query, filter.page)
          throw new Error('Выбранный КТК больше недоступен. Выберите другой из остатков.')
        }
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
        <button type="submit" className="primary-button" disabled={busy || !selected || !transport.trim() || !operationTime}>{busy ? 'Отправляем…' : 'Отправить'}</button>
        <button type="button" className="close-button" aria-label="Закрыть форму пакета" disabled={busy} onClick={onClose}>×</button>
      </div></header>
      <div className="route-drawer-body">
        {error && <p className="error-message" role="alert">{error}</p>}
        <p>Пакет зафиксирует вывоз одного КТК по заявке №{order.code}.</p>
        {group && <p>{group.ownerName && group.ownerName + ' · '}{containerTypeLabel(group.type)} · Порожний</p>}
        <label>Поиск по номеру КТК<UiInput type="search" disabled={busy || !type} autoComplete="off"
          value={filter.query} onChange={e => changeFilter(e.target.value, 0)} /></label>
        {!type ? <p role="alert">В плане заявки отсутствует типоразмер КТК.</p>
          : !result ? <p role="status">Загружаем свободные КТК…</p>
          : 'error' in result ? <div role="alert">{result.error} <button type="button" className="secondary-button"
            onClick={() => changeFilter(filter.query, filter.page)}>Повторить</button></div>
          : !result.data.items.length ? <p role="status">{filter.query.trim() ? 'По этому номеру свободных КТК не найдено.' : 'Подходящих свободных КТК нет.'}</p>
          : <fieldset className="shipment-stock-picker" disabled={busy}>
            <legend>Свободные КТК из остатков</legend>
            <div className="shipment-stock-options">{result.data.items.map(row => <label key={row.containerId}>
              <UiInput type="radio" name={listId + '-container'} value={row.containerId} checked={selectedId === row.containerId}
                onChange={() => { setSelectedId(row.containerId); setError('') }} />{row.containerName}{!owner && row.clientName && <span>· {row.clientName}</span>}
            </label>)}</div>
            {result.data.totalPages > 1 && <div className="pagination">
              <button type="button" disabled={filter.page === 0} onClick={() => changeFilter(filter.query, filter.page - 1)}>Назад</button>
              <span>{filter.page + 1} / {result.data.totalPages}</span>
              <button type="button" disabled={filter.page + 1 === result.data.totalPages} onClick={() => changeFilter(filter.query, filter.page + 1)}>Далее</button>
            </div>}
          </fieldset>}
        <label>Номер автомобиля<UiInput required disabled={busy} value={transport} onChange={e => setTransport(e.target.value)} /></label>
        <label>Время вывоза (МСК)<UiInput required type="datetime-local" step="any" disabled={busy} value={operationTime} onChange={e => setTime(e.target.value)} /></label>
      </div>
    </form>
  </dialog></AppOverlay>
}
