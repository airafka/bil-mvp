import { historyOrderPath } from '../containerStock'
import { useApplicationClock } from '../applicationClock'
import { Fragment, useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { request } from '../http'
import type { PagedResponse, ReferenceOption } from '../domain'
import { UiSelect } from '../components/FormControls'
import { TableReveal } from '../components/TableReveal'
import { storageBoundaryLabel, storageDate, storageClientOwner, storageTransport, type StorageVisit } from '../containerStorage'
import './ContainerStoragePage.css'

const columns = [44, 140, 90, 145, 105, 145, 105, 240, 110, 240, 220, 240, 110, 240, 220]
const periodColumns = [220, 90, 145, 160, 105, 145, 160, 105]

export function StorageVisitsTable({ rows, emptyText, selectedPeriodId }: { rows: StorageVisit[]; emptyText: string; selectedPeriodId?: string }) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  return <table className="storage-table"><colgroup>{columns.map((width, i) => <col key={i} style={{ width }} />)}</colgroup>
    <thead><tr><th aria-label="Раскрытие визита" /><th>Номер КТК</th><th>Дней хранения</th><th>Дата receiving</th><th>Заявка receiving</th><th>Дата shipping</th><th>Заявка shipping</th>
      <th>Клиент/Собственник receiving</th><th>Транспорт receiving</th><th>Грузоперевозчик/грузоотправитель receiving</th><th>Груз receiving</th>
      <th>Клиент/Собственник shipping</th><th>Транспорт shipping</th><th>Грузоперевозчик/грузополучатель shipping</th><th>Груз shipping</th></tr></thead>
    <tbody>{rows.length ? rows.map(visit => {
      const first = visit.periods[0], last = visit.periods[visit.periods.length - 1]
      const open = expanded[visit.id] ?? visit.periods.some(period => period.id === selectedPeriodId)
      const detailsId = 'storage-visit-' + visit.id
      return <Fragment key={visit.id}>
        <tr data-visit-id={visit.id} className={open ? 'storage-visit-open' : ''}>
          <td className="registry-index"><button type="button" className="storage-expand" aria-expanded={open} aria-controls={detailsId} aria-label={(open ? 'Свернуть' : 'Раскрыть') + ' визит ' + visit.containerName + ' от ' + storageDate(visit.receivingAt)} onClick={() => setExpanded(value => ({ ...value, [visit.id]: !open }))}><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3 5 5-5 5" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg></button></td>
          <td><Link to={'/container-owners/' + visit.containerId + '/history'}>{visit.containerName}</Link></td>
          <td>{visit.storageDays}</td><td>{storageDate(visit.receivingAt)}</td>
          <td><Link to={historyOrderPath({ orderId: visit.receivingOrderId, orderType: 'RECEIVING_ORDER' })}>{visit.receivingOrderNumber}</Link></td>
          <td>{visit.shippingAt ? storageDate(visit.shippingAt) : ''}</td>
          <td>{visit.shippingOrderId && <Link to={historyOrderPath({ orderId: visit.shippingOrderId, orderType: 'SHIPPING_ORDER' })}>{visit.shippingOrderNumber}</Link>}</td>
          <td>{storageClientOwner(first.receivingClientName, first.receivingOwnerName)}</td><td>{storageTransport(first.arrivalTransport)}</td><td>{first.arrivalParty}</td><td>{first.arrivalCargo}</td>
          <td>{storageClientOwner(last.shippingClientName, last.shippingOwnerName)}</td><td>{storageTransport(last.departureTransport)}</td><td>{last.departureParty}</td><td>{last.departureCargo}</td>
        </tr>
        {open && <tr className="storage-visit-details" id={detailsId}><td colSpan={columns.length}>
          <div className="storage-period-frame"><table className="storage-period-table" aria-label={'Собственники визита ' + visit.containerName + ' от ' + storageDate(visit.receivingAt)}>
            <caption>Собственники и передачи</caption><colgroup>{periodColumns.map((width, i) => <col key={i} style={{ width }} />)}</colgroup>
            <thead><tr><th>Собственник КТК</th><th>Дней хранения</th><th>Начало периода</th><th>Событие</th><th>Заявка</th><th>Конец периода</th><th>Событие</th><th>Заявка</th></tr></thead>
            <tbody>{visit.periods.map(row => <tr key={row.id} data-period-id={row.id} className={row.id === selectedPeriodId ? 'storage-period-selected' : ''}>
              <td>{row.ownerName || '—'}</td><td>{row.storageDays}</td><td>{storageDate(row.arrivalAt)}</td><td>{storageBoundaryLabel(row.startOrderType)}</td>
              <td>{row.startOrderId && row.startOrderType && <Link to={historyOrderPath({ orderId: row.startOrderId, orderType: row.startOrderType })}>{row.startOrderNumber}</Link>}</td>
              <td>{row.departureAt ? storageDate(row.departureAt) : ''}</td><td>{storageBoundaryLabel(row.endOrderType)}</td>
              <td>{row.endOrderId && row.endOrderType && <Link to={historyOrderPath({ orderId: row.endOrderId, orderType: row.endOrderType })}>{row.endOrderNumber}</Link>}</td>
            </tr>)}</tbody>
          </table></div>
        </td></tr>}
      </Fragment>
    }) : <tr><td colSpan={columns.length} className="table-message">{emptyText}</td></tr>}</tbody>
  </table>
}

export default function ContainerStoragePage() {
  const { clock } = useApplicationClock()
  const [params, setParams] = useSearchParams()
  const query = params.get('query') || ''
  const page = Math.max(0, Number(params.get('page')) || 0)
  const [draftSearch, setDraftSearch] = useState({ query, value: query })
  const search = draftSearch.query === query ? draftSearch.value : query
  const [attempt, setAttempt] = useState(0)
  const pageSize = 20
  const filter = new URLSearchParams({ query, status: params.has('periodId') ? 'ALL' : 'ACTIVE' })
  if(params.get('periodId')) filter.set('periodId',params.get('periodId')!)
  const url = '/api/container-storage-periods/visits?' + filter + '&page=' + page + '&size=' + pageSize
  const requestKey = url + ':' + attempt + ':' + clock.date + ':' + clock.version
  const [result, setResult] = useState<{ key: string; data: PagedResponse<StorageVisit>; containers: ReferenceOption[] } | null>(null)
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null)
  const error = failure?.key === requestKey ? failure.message : ''
  const loading = result?.key !== requestKey && !error
  const data = result?.key === requestKey ? result.data : null
  useEffect(() => {
    let active = true
    Promise.all([request<PagedResponse<StorageVisit>>(url), request<ReferenceOption[]>('/api/container-storage-periods/containers')])
      .then(([data, containers]) => { if (active) { setResult({ key: requestKey, data, containers }); setFailure(null) } })
      .catch((cause: unknown) => { if (active) setFailure({ key: requestKey, message: cause instanceof Error ? cause.message : 'Не удалось загрузить хранение' }) })
    return () => { active = false }
  }, [url, requestKey])
  useEffect(() => {
    if (!data || page < Math.max(1, data.totalPages)) return
    setParams(current => {
      const next = new URLSearchParams(current)
      if (data.totalPages > 1) next.set('page', String(data.totalPages - 1)); else next.delete('page')
      return next
    }, { replace: true })
  }, [data, page, setParams])
  function change(name: string, value: string) {
    const next = new URLSearchParams(params); if (value) next.set(name, value); else next.delete(name)
    if (name !== 'page') next.delete('page')
    setParams(next)
  }
  return <section className="registry-page storage-page">
    <div className="page-header"><h1>Хранение КТК</h1><div className="storage-actions"><button className="secondary-button" onClick={() => setAttempt(a => a + 1)}>Обновить</button>
      <a className="secondary-button" href={'/api/container-storage-periods/export?' + filter}>Выгрузить CSV</a></div></div>
    <form className="storage-filters" onSubmit={e => { e.preventDefault(); change('query', search) }}>
      <label className="field horizontal-field"><span>Номер КТК</span><UiSelect value={search} disabled={loading || !!error} onChange={e => setDraftSearch({ query, value: e.target.value })}>
        <option value="">{loading ? 'Загрузка…' : 'Все КТК'}</option>
        {search && !result?.containers.some(item => item.name === search) && <option value={search}>{search}</option>}
        {result?.containers.map(item => <option key={item.id} value={item.name}>{item.name}</option>)}
      </UiSelect></label>
      <button className="secondary-button" type="submit" disabled={loading || !!error}>Найти</button>
      {params.size > 0 && <button type="button" className="secondary-button" onClick={() => { setParams({}); setDraftSearch({ query: '', value: '' }) }}>Сбросить</button>}
    </form>
    {params.has('periodId') && <p>Показан визит с выбранным периодом хранения.</p>}
    {error && <div role="alert" className="storage-review">{error} <button onClick={() => setAttempt(a => a + 1)}>Повторить</button></div>}

    <TableReveal loading={loading}><div className="table-wrap" data-page-size={pageSize}><StorageVisitsTable key={query + (params.get('periodId') || '')} rows={data?.items || []} selectedPeriodId={params.get('periodId') || undefined} emptyText={error ? 'Данные не загружены' : 'Визиты хранения не найдены'} /></div></TableReveal>
    <div className="pagination"><span>Всего визитов: {data?.totalElements ?? result?.data.totalElements ?? '—'}</span>
      <button disabled={loading || page === 0} onClick={() => change('page', String(page - 1))}>Назад</button><span>{page + 1} / {Math.max(1, data?.totalPages ?? result?.data.totalPages ?? 1)}</span>
      <button disabled={loading || !data || page + 1 >= data.totalPages} onClick={() => change('page', String(page + 1))}>Далее</button></div>
  </section>
}
