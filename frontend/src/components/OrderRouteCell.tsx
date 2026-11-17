import { useRouteAutofill } from '../useRouteAutofill'
import { useBusinessDateTime, businessDateTimeToInstant } from '../applicationClock'
import { AppOverlay } from './AppOverlay'
import { RouteLogisticsFields } from './RouteLogisticsFields'
import { Notification } from './Notification'
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { createRoute } from '../api'
import type { ServiceTransportOrder } from '../comprehensiveServiceOrder'
import { UiInput, UiTextarea } from './FormControls'

export function OrderRouteCell({ order, disabled = false }: { order?: ServiceTransportOrder; disabled?: boolean }) {
  const [createdRoute, setCreatedRoute] = useState<{ id: string; code: number } | null>(null)
  const [open, setOpen] = useState(false)
  if (!order) return <span>—</span>
  const route = createdRoute ?? order.route
  if (route) return <Link className="order-code" to={'/routes/' + route.id}>Рейс {route.code}</Link>
  return <>
    <button type="button" className="secondary-button create-route-button" disabled={disabled || order.status !== 'DRAFT'} title={order.status !== 'DRAFT' ? 'Добавление в рейс доступно для черновика заявки' : undefined} onClick={() => setOpen(true)}>Создать рейс</button>
    {open && <RouteDrawer order={order} onClose={() => setOpen(false)} onCreated={value => { setCreatedRoute(value); setOpen(false) }} />}
  </>
}

function RouteDrawer({ order, onClose, onCreated }: { order: ServiceTransportOrder; onClose: () => void; onCreated: (route: { id: string; code: number }) => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const lock = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [date, setDate] = useBusinessDateTime()
  const [carrier, setCarrier] = useState('')
  const [driver, setDriver] = useState('')
  const [vehicle, setVehicle] = useState('')
  const [comment, setComment] = useState('')
  const { filling, fill } = useRouteAutofill(order.transportType ?? 'VEHICLE', { date, carrier, driver, vehicle }, next => { setDate(next.date); setCarrier(next.carrier); setDriver(next.driver); setVehicle(next.vehicle) }, setError)
  useEffect(() => { dialog.current?.showModal() }, [])
  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    event.stopPropagation()
    if (lock.current || filling || !order.terminalAreaId || !order.transportType) return
    lock.current = true; setBusy(true); setError('')
    try {
      const result = await createRoute({ routeType: order.kind, transportType: order.transportType, terminalAreaId: order.terminalAreaId,
        departureAt: businessDateTimeToInstant(date), carrierId:order.transportType==='VEHICLE'?carrier||null:null,driverId:order.transportType==='VEHICLE'?driver||null:null,vehicleId:order.transportType==='VEHICLE'?vehicle||null:null,comment, orderIds: [order.id] })
      onCreated(result.route)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось создать рейс') }
    finally { lock.current = false; setBusy(false) }
  }
  return <AppOverlay><dialog onDoubleClick={event => event.stopPropagation()} ref={dialog} className="route-side-dialog" aria-labelledby="route-drawer-title" onCancel={event => { event.preventDefault(); if (!busy && !filling) onClose() }}>
    <form onSubmit={save}>
      <header className="route-dialog-heading"><h2 id="route-drawer-title">Создать рейс</h2><div className="header-actions"><button type="button" className="secondary-button" disabled={busy || filling || !order.transportType} onClick={()=>void fill()}>{filling?'Заполняем…':'Автозаполнить'}</button><button type="submit" className="primary-button create-action-button create-route-button" disabled={busy || filling || !order.terminalAreaId || !order.transportType}>{busy ? 'Создаём…' : 'Создать рейс'}</button><button type="button" className="close-button" title="Закрыть" aria-label="Закрыть форму рейса" disabled={busy || filling} onClick={onClose}>×</button></div></header>
      <div className="route-drawer-body">
        <label className="field horizontal-field"><span>Дата и время <b>*</b></span><UiInput autoFocus type="datetime-local" required value={date} disabled={busy || filling} onChange={event => setDate(event.target.value)} /></label>
        {order.transportType === 'VEHICLE' && <RouteLogisticsFields carrierId={carrier} driverId={driver} vehicleId={vehicle} onCarrier={setCarrier} onDriver={setDriver} onVehicle={setVehicle} disabled={busy || filling} showHeading={false} showReferenceInfo={false}>
        <label className="field horizontal-field"><span>Комментарий</span><UiTextarea maxLength={200} value={comment} disabled={busy || filling} onChange={event => setComment(event.target.value)} /></label>
        </RouteLogisticsFields>}
        {!(order.transportType === 'VEHICLE') && <label className="field horizontal-field"><span>Комментарий</span><UiTextarea maxLength={200} value={comment} disabled={busy || filling} onChange={event => setComment(event.target.value)} /></label>}

        {error && <Notification kind="error">{error}</Notification>}
      </div>
    </form>
  </dialog></AppOverlay>
}
