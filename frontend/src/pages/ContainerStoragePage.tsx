import { historyOrderPath } from '../containerStock'
import { businessDateLabel, useApplicationClock } from '../applicationClock'
import { Fragment, useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { request } from '../http'
import type { PagedResponse, ReferenceOption } from '../domain'
import { StoragePeriodDialog } from '../components/StoragePeriodDialog'
import { allDates, monthBounds, validMonth, wholeMonths, type StorageDateRange } from '../storageDateRange'
import { StorageContainerFilter } from '../components/StorageContainerFilter'
import { TableReveal } from '../components/TableReveal'
import { storageBoundaryLabel, storageDate, storageClientOwner, storageTransport, type StorageVisit } from '../containerStorage'
import './ContainerStoragePage.css'

const eventColumns = [145, 150, 105, 145, 150, 105, 240, 110, 240, 220, 240, 110, 240, 220]

export function StorageVisitsTable({ rows, emptyText, selectedPeriodId, showPeriodDays }: {
  rows: StorageVisit[]; emptyText: string; selectedPeriodId?: string; showPeriodDays: boolean
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const columns = [44, 140, 200, 90, ...(showPeriodDays ? [130] : []), ...eventColumns]
  return <table className="storage-table"><colgroup>{columns.map((width, i) => <col key={i} style={{ width }} />)}</colgroup>
    <thead><tr><th aria-label="Раскрытие визита" /><th>Номер КТК</th><th>Собственник КТК</th><th>Дней хранения</th>
      {showPeriodDays && <th>Дней хранения в периоде</th>}
      <th>Начало периода (UTC)</th><th>Событие</th><th>Заявка</th><th>Конец периода (UTC)</th><th>Событие</th><th>Заявка</th>
      <th>Клиент/Собственник поставки</th><th>Транспорт поставки</th><th>Экспедитор/грузоотправитель поставки</th><th>Груз поставки</th>
      <th>Клиент/Собственник вывоза</th><th>Транспорт вывоза</th><th>Экспедитор/грузополучатель вывоза</th><th>Груз вывоза</th></tr></thead>
    <tbody>{rows.length ? rows.map(visit => {
      const first = visit.periods[0], last = visit.periods[visit.periods.length - 1]
      const open = expanded[visit.id] ?? visit.periods.some(period => period.id === selectedPeriodId)
      const detailsId = 'storage-visit-' + visit.id
      return <Fragment key={visit.id}>
        <tr data-visit-id={visit.id} className={'storage-visit-row' + (open ? ' storage-visit-open' : '')}>
          <td className="registry-index"><button type="button" className="storage-expand" aria-expanded={open} aria-controls={open ? visit.periods.map(period => detailsId + '-' + period.id).join(' ') : undefined} aria-label={(open ? 'Свернуть' : 'Раскрыть') + ' визит ' + visit.containerName + ' от ' + storageDate(visit.receivingAt)} onClick={() => setExpanded(value => ({ ...value, [visit.id]: !open }))}><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3 5 5-5 5" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg></button></td>
          <td><Link to={'/container-owners/' + visit.containerId + '/history'}>{visit.containerName}</Link></td>
          <td>{last.ownerName || '—'}</td><td className="storage-visit-total">{visit.storageDays}</td>
          {showPeriodDays && <td className="storage-visit-total">{visit.storageDaysInPeriod}</td>}
          <td>{storageDate(visit.receivingAt)}</td><td>Поставка</td>
          <td><Link to={historyOrderPath({ orderId: visit.receivingOrderId, orderType: 'RECEIVING_ORDER' })}>{visit.receivingOrderNumber}</Link></td>
          <td>{visit.shippingAt ? storageDate(visit.shippingAt) : ''}</td><td>{visit.shippingAt ? 'Вывоз' : ''}</td>
          <td>{visit.shippingOrderId && <Link to={historyOrderPath({ orderId: visit.shippingOrderId, orderType: 'SHIPPING_ORDER' })}>{visit.shippingOrderNumber}</Link>}</td>
          <td>{storageClientOwner(first.receivingClientName, first.receivingOwnerName)}</td><td>{storageTransport(first.arrivalTransport)}</td><td>{first.arrivalParty}</td><td>{first.arrivalCargo}</td>
          <td>{storageClientOwner(last.shippingClientName, last.shippingOwnerName)}</td><td>{storageTransport(last.departureTransport)}</td><td>{last.departureParty}</td><td>{last.departureCargo}</td>
        </tr>
        {open && visit.periods.map((row, index) => <tr key={row.id} id={detailsId + '-' + row.id} data-period-id={row.id} className={'storage-period-row' + (index === visit.periods.length - 1 ? ' storage-period-last' : '') + (row.id === selectedPeriodId ? ' storage-period-selected' : '')}>
          <td className="storage-period-guide" aria-hidden="true" /><td />
          <td>{row.ownerName || '—'}</td><td>{row.storageDays}</td>
          {showPeriodDays && <td>{row.storageDaysInPeriod}</td>}
          <td>{storageDate(row.arrivalAt)}</td><td>{storageBoundaryLabel(row.startOrderType)}</td>
          <td>{row.startOrderId && row.startOrderType && <Link to={historyOrderPath({ orderId: row.startOrderId, orderType: row.startOrderType })}>{row.startOrderNumber}</Link>}</td>
          <td>{row.departureAt ? storageDate(row.departureAt) : ''}</td><td>{storageBoundaryLabel(row.endOrderType)}</td>
          <td>{row.endOrderId && row.endOrderType && <Link to={historyOrderPath({ orderId: row.endOrderId, orderType: row.endOrderType })}>{row.endOrderNumber}</Link>}</td>
          <td colSpan={8} />
        </tr>)}
      </Fragment>
    }) : <tr><td colSpan={columns.length} className="table-message">{emptyText}</td></tr>}</tbody>
  </table>
}

type StorageFilters = { query: string; month: string; storedFrom: string; storedTo: string }

function StorageFilterForm({ initial, containers, onApply, onReset }: {
  initial: StorageFilters; containers: ReferenceOption[]; onApply: (filters: StorageFilters) => void; onReset: () => void
}) {
  const [query, setQuery] = useState(initial.query)
  const [dates, setDates] = useState<StorageDateRange>(() => validMonth(initial.month)
    ? wholeMonths(initial.month) : { from: initial.storedFrom, to: initial.storedTo })
  const [choosingPeriod, setChoosingPeriod] = useState(false)
  const periodLabel = [dates.from, dates.to].map(businessDateLabel).join(' — ')
  function apply() {
    const bounds = monthBounds(dates)
    const month = bounds.length === 1 ? bounds[0] : ''
    onApply({ query: query.trim(), month, storedFrom: month ? '' : dates.from, storedTo: month ? '' : dates.to })
  }
  return <><form className="storage-filters" aria-label="Фильтры хранения" onSubmit={event => { event.preventDefault(); apply() }}>
    <StorageContainerFilter value={query} containers={containers} onChange={setQuery} />
    <label className="field storage-period-field">Период<button type="button" className="ui-control ui-select storage-period-trigger"
      aria-haspopup="dialog" aria-expanded={choosingPeriod} onClick={() => setChoosingPeriod(true)}>
      {dates.from || dates.to ? periodLabel : 'За всё время'}
    </button></label>
    <div className="storage-actions"><button type="submit" className="primary-button">Сформировать</button>
      <button type="button" className="secondary-button" onClick={() => {
        setQuery(''); setDates(allDates); onReset()
      }}>Сбросить</button></div>
  </form>
    {choosingPeriod && <StoragePeriodDialog initial={dates} onClose={range => {
      if (range) setDates(range)
      setChoosingPeriod(false)
    }} />}
  </>
}

export default function ContainerStoragePage() {
  const { clock } = useApplicationClock()
  const [params, setParams] = useSearchParams()
  const [attempt, setAttempt] = useState(0)
  const [optionsAttempt, setOptionsAttempt] = useState(0)
  const [containers, setContainers] = useState<ReferenceOption[]>([])
  const [optionsError, setOptionsError] = useState(false)
  const periodId = params.get('periodId') || ''
  const initial = { query: params.get('query') || '', month: params.get('month') || '',
    storedFrom: params.get('storedFrom') || '', storedTo: params.get('storedTo') || '' }
  const applied = new URLSearchParams()
  for (const [name, value] of Object.entries(initial)) if (value) applied.set(name, value)
  const generated = params.has('report') || !!periodId || applied.size > 0
  const page = Math.max(0, Number(params.get('page')) || 0)
  const pageSize = 20
  const exportFilter = new URLSearchParams(applied)
  if (periodId) { applied.set('periodId', periodId); exportFilter.set('visitPeriodId', periodId) }
  const url = '/api/container-periods/visits?' + applied + '&page=' + page + '&size=' + pageSize
  const requestKey = url + ':' + attempt + ':' + clock.date + ':' + clock.version
  const [result, setResult] = useState<{ key: string; data: PagedResponse<StorageVisit> } | null>(null)
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null)
  const error = failure?.key === requestKey ? failure.message : ''
  const loading = generated && result?.key !== requestKey && !error
  const data = generated && result?.key === requestKey ? result.data : null

  useEffect(() => {
    let active = true
    request<ReferenceOption[]>('/api/container-periods/containers')
      .then(rows => { if (active) { setContainers(rows); setOptionsError(false) } })
      .catch(() => { if (active) setOptionsError(true) })
    return () => { active = false }
  }, [clock.date, clock.version, optionsAttempt])

  useEffect(() => {
    if (!generated) return
    const controller = new AbortController()
    request<PagedResponse<StorageVisit>>(url, { signal: controller.signal })
      .then(data => { if (!controller.signal.aborted) { setResult({ key: requestKey, data }); setFailure(null) } })
      .catch((cause: unknown) => { if (!controller.signal.aborted) setFailure({ key: requestKey, message: cause instanceof Error ? cause.message : 'Не удалось загрузить хранение' }) })
    return () => controller.abort()
  }, [generated, url, requestKey])

  useEffect(() => {
    if (!data || page < Math.max(1, data.totalPages)) return
    setParams(current => {
      const next = new URLSearchParams(current)
      if (data.totalPages > 1) next.set('page', String(data.totalPages - 1)); else next.delete('page')
      return next
    }, { replace: true })
  }, [data, page, setParams])

  function apply(filters: StorageFilters) {
    const next = new URLSearchParams({ report: '1' })
    for (const [name, value] of Object.entries(filters)) if (value) next.set(name, value)
    setParams(next)
    setAttempt(a => a + 1)
  }
  function goToPage(value: number) {
    const next = new URLSearchParams(params)
    if (value) next.set('page', String(value)); else next.delete('page')
    setParams(next)
  }

  return <section className="registry-page storage-page">
    <div className="page-header"><h1>Хранение КТК</h1>
      {data && <a className="secondary-button" href={'/api/container-periods/export?' + exportFilter}>Выгрузить CSV</a>}
    </div>
    <StorageFilterForm key={String(generated) + applied.toString()} initial={initial} containers={containers} onApply={apply} onReset={() => setParams({})} />
    {optionsError && <div role="alert" className="storage-review">Не удалось загрузить номера КТК. <button onClick={() => setOptionsAttempt(a => a + 1)}>Повторить</button></div>}
    {periodId && <p>Показан визит с выбранным периодом хранения.</p>}
    {generated && <>
      {error && <div role="alert" className="storage-review">{error} <button onClick={() => setAttempt(a => a + 1)}>Повторить</button></div>}
      <TableReveal loading={loading}><div className="table-wrap" data-page-size={pageSize}><StorageVisitsTable key={applied.toString()} rows={data?.items || []} selectedPeriodId={periodId || undefined}
        showPeriodDays={!!(initial.month || initial.storedFrom || initial.storedTo)} emptyText={error ? 'Данные не загружены' : 'Визиты хранения не найдены'} /></div></TableReveal>
      <div className="pagination"><span>Всего визитов: {data?.totalElements ?? '—'}</span>
        <button disabled={loading || page === 0} onClick={() => goToPage(page - 1)}>Назад</button><span>{page + 1} / {Math.max(1, data?.totalPages ?? 1)}</span>
        <button disabled={loading || !data || page + 1 >= data.totalPages} onClick={() => goToPage(page + 1)}>Далее</button></div>
    </>}
  </section>
}
