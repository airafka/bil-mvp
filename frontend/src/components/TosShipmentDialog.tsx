import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { getContainerStock } from '../api'
import { businessDateTimeToInstant, useApplicationClock, businessDateTime } from '../applicationClock'
import { containerTypeLabel, type OrderDetails } from '../domain'
import { request } from '../http'
import { remainingShipmentGroups } from '../shipmentResultGroups'
import { AppOverlay } from './AppOverlay'
import { UiInput, UiSelect } from './FormControls'

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
  const knownContainers = order.fillingType === 'CONTAINER'
  const knownWagons = order.fillingType === 'RAILWAY_CARRIAGE'
  const railway = order.transportType === 'RAILWAY'
  const [number, setNumber] = useState('')
  const [transport, setTransport] = useState(railway
    ? (knownWagons && order.railwayCarriages.length === 1 ? order.railwayCarriages[0].railwayCarriageCode : '')
    : vehicleNumber ?? '')
  const groups = remainingShipmentGroups(order)
  const [groupId, setGroupId] = useState(groups[0]?.id ?? '')
  const [seal, setSeal] = useState('')
  const [enteredTime, setTime] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [stock, setStock] = useState<string[]>([])
  const [wagons, setWagons] = useState<string[]>([])
  const group = groups.find(row => row.id === groupId)
  const known = order.containers.find(row => row.containerName === number)
  const operationTime = enteredTime ?? businessDateTime(clock) + new Date(clock.now).toISOString().slice(16, 23)

  useEffect(() => {
    const element = dialog.current
    element?.showModal()
    void refresh()
    return () => element?.close()
  }, [refresh])

  useEffect(() => {
    if (knownContainers) return
    let active = true
    const timer = window.setTimeout(() => {
      getContainerStock(number, group?.ownerClientId ?? '', 'ON_TERMINAL').then(page => {
        if (active) setStock(page.items.filter(row => row.containerType === group?.type).map(row => row.containerName))
      }).catch(() => { if (active) setStock([]) })
    }, 150)
    return () => { active = false; window.clearTimeout(timer) }
  }, [number, knownContainers, group?.type, group?.ownerClientId])

  useEffect(() => {
    if (!railway || knownWagons) return
    let active = true
    const timer = window.setTimeout(() => {
      request<{name: string}[]>('/api/shipping-orders/' + order.id + '/available-wagons?q=' + encodeURIComponent(transport)).then(rows => {
        if (active) setWagons(rows.map(row => row.name))
      }).catch(() => { if (active) setWagons([]) })
    }, 150)
    return () => { active = false; window.clearTimeout(timer) }
  }, [order.id, railway, knownWagons, transport])

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (lock.current) return
    lock.current = true
    setBusy(true)
    setError('')
    try {
      const cargoNumber = number.trim().toUpperCase()
      let taskId = knownContainers ? known?.taskId : taskIds.current.get(cargoNumber)
      const type = knownContainers ? known?.containerType : group?.type
      if (!type || (knownContainers && !taskId)) throw new Error('Выберите КТК из заявки')
      if (!taskId) {
        const page = await getContainerStock(cargoNumber, group?.ownerClientId ?? '', 'ON_TERMINAL')
        if (!page.items.some(row => row.containerName.toUpperCase() === cargoNumber && row.containerType === type))
          throw new Error('Выберите свободный КТК указанного типоразмера из остатков')
        taskId = crypto.randomUUID()
        taskIds.current.set(cargoNumber, taskId)
      }
      const cargoSpec = knownContainers
        ? known?.cargoItems?.map(item => ({ code: item.etsngCodeName, qty: item.weight }))
        : group?.items.map(item => ({ code: item.etsngCode, qty: item.weight }))
      const result = await request<{ status: string; details: string | null }>('/datareon/event', {
        method: 'POST', headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          _id: taskId, _order: order.id, orderNumber: String(order.code), source: 'TOS', site: order.terminalArea.name,
          eventName: 'Погрузка завершена', eventCode: 'LOAD_FINISH', eventDateTime: businessDateTimeToInstant(operationTime),
          cargoResult: [{
            cargoNumber, cargoType: type === 'STANDARD_40' ? 'Контейнер 40' : 'Контейнер 20', qty: 1, active: true,
            transportType: railway ? 'ЖД' : 'АВТО', transportNumber: transport.trim(),
            seals: seal.split(',').map(value => value.trim()).filter(Boolean).map(code => ({ code })),
            cargoSpec: cargoSpec ?? [],
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
        {!knownContainers && <label>Плановая группа КТК<UiSelect required disabled={busy} value={groupId} onChange={e => { setGroupId(e.target.value); setNumber('') }}>
          {groups.map(row => <option key={row.id} value={row.id}>{row.ownerName && row.ownerName + ' · '}{containerTypeLabel(row.type)} · {row.empty ? 'Порожние' : 'Гружёные'} · осталось {row.remaining} шт.{row.items.map(item => ' · ' + item.etsngCode + ' (' + item.weight + ' кг)').join('')}</option>)}
        </UiSelect></label>}
        <label>Номер КТК{knownContainers
          ? <UiSelect required disabled={busy} value={number} onChange={e => {
              setNumber(e.target.value)
              setSeal(order.containers.find(row => row.containerName === e.target.value)?.sealNumbers ?? '')
            }}><option value="">Выберите КТК</option>{order.containers.map(row => <option key={row.containerId}>{row.containerName}</option>)}</UiSelect>
          : <UiInput required disabled={busy} list={listId + '-stock'} autoComplete="off" placeholder="Номер КТК из остатков" value={number} onChange={e => setNumber(e.target.value)} />}
        </label>
        <datalist id={listId + '-stock'}>{stock.map(code => <option key={code} value={code} />)}</datalist>
        <label>{railway ? 'Номер вагона' : 'Номер автомобиля'}{knownWagons
          ? <UiSelect required disabled={busy} value={transport} onChange={e => setTransport(e.target.value)}><option value="">Выберите вагон</option>{order.railwayCarriages.map(row => <option key={row.railwayCarriageId}>{row.railwayCarriageCode}</option>)}</UiSelect>
          : <UiInput required disabled={busy} list={railway ? listId + '-wagons' : undefined} autoComplete="off" value={transport} onChange={e => setTransport(e.target.value)} />}
        </label>
        <datalist id={listId + '-wagons'}>{wagons.map(code => <option key={code} value={code} />)}</datalist>
        {railway && <label>Номера ЗПУ<UiInput disabled={busy} value={seal} placeholder="Через запятую" onChange={e => setSeal(e.target.value)} /></label>}
        <label>Время вывоза (МСК)<UiInput required type="datetime-local" step="any" disabled={busy} value={operationTime} onChange={e => setTime(e.target.value)} /></label>
        {error && <p className="error-message" role="alert">{error}</p>}
      </div>
    </form>
  </dialog></AppOverlay>
}
