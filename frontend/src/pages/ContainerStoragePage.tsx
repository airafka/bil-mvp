import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { request } from '../http'
import type { PagedResponse } from '../domain'
import { UiInput } from '../components/FormControls'
import { TableReveal } from '../components/TableReveal'
import { storageCargoName, storageDate, timeSourceLabel, transportLabel, type StorageIssue, type StoragePeriod } from '../containerStorage'
import './ContainerStoragePage.css'

const columns = [160, 175, 175, 100, 155, 260, 200, 110, 190, 180, 155, 260, 110, 190, 190]
const parties = (client?: string, owner?: string) => `${client || '—'} / ${owner || '—'}`

export function StorageTable({ rows, emptyText }: { rows: StoragePeriod[]; emptyText: string }) {
  return <table className="storage-table"><colgroup>{columns.map((width, i) => <col key={i} style={{ width }} />)}</colgroup>
    <thead><tr><th>Номер КТК</th><th>Прибыл</th><th>Вывезен</th><th>Дней хранения</th>
      <th>Заявка поставки</th><th>Клиент/собственник поставки</th><th>Грузоотправитель</th>
      <th>Транспорт поставки</th><th>Перевозчик поставки</th><th>Груз</th><th>Заявка вывоза</th><th>Клиент/собственник вывоза</th>
      <th>Транспорт вывоза</th><th>Перевозчик вывоза</th><th>Грузополучатель</th></tr></thead>
    <tbody>{rows.length ? rows.map(row => <tr key={row.id}>
      <td><Link to={'/container-owners/' + row.containerId + '/history'}>{row.containerName}</Link></td>
      <td title={timeSourceLabel(row.arrivalTimeSource)}>{storageDate(row.arrivalAt)}{row.arrivalTimeSource === 'HISTORY_CREATED' && <div className="storage-note">По старой истории</div>}</td>
      <td title={row.departureAt ? timeSourceLabel(row.departureTimeSource) : undefined}>{storageDate(row.departureAt)}</td>
      <td>{row.storageDays ?? '—'}{row.needsReview && <div className="storage-review" title={row.reviewReason}>Требуется проверка</div>}</td>
      <td><Link to={'/receiving-orders/' + row.receivingOrderId}>{row.receivingOrderNumber}</Link></td>
      <td>{parties(row.clientName, row.ownerName)}</td><td>{row.consignor || '—'}</td><td>{transportLabel(row.arrivalTransport)}</td><td>{row.arrivalCarrier || '—'}</td>
      <td>{storageCargoName(row.cargoName)}</td>
      <td>{row.shippingOrderId ? <Link to={'/shipping-orders/' + row.shippingOrderId}>{row.shippingOrderNumber}</Link> : '—'}</td>
      <td>{row.shippingOrderId ? parties(row.shippingClientName, row.shippingOwnerName) : '—'}</td>
      <td>{transportLabel(row.departureTransport)}</td><td>{row.departureCarrier || '—'}</td><td>{row.consignee || '—'}</td>
    </tr>) : <tr><td colSpan={columns.length} className="table-message">{emptyText}</td></tr>}</tbody>
  </table>
}

export default function ContainerStoragePage() {
  const [params, setParams] = useSearchParams()
  const query = params.get('query') || ''
  const page = Math.max(0, Number(params.get('page')) || 0)
  const [draftSearch, setDraftSearch] = useState({ query, value: query })
  const search = draftSearch.query === query ? draftSearch.value : query
  const [attempt, setAttempt] = useState(0)
  const filter = new URLSearchParams({ query, status: params.has('periodId') ? 'ALL' : 'ACTIVE' })
  if(params.get('periodId')) filter.set('periodId',params.get('periodId')!)
  const url = '/api/container-storage-periods?' + filter + '&page=' + page
  const requestKey = url + ':' + attempt
  const [result, setResult] = useState<{ key: string; data: PagedResponse<StoragePeriod>; issues: StorageIssue[] } | null>(null)
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null)
  const error = failure?.key === requestKey ? failure.message : ''
  const loading = result?.key !== requestKey && !error
  const data = result?.key === requestKey ? result.data : null
  useEffect(() => {
    let active = true
    Promise.all([request<PagedResponse<StoragePeriod>>(url), request<StorageIssue[]>('/api/container-storage-periods/issues')])
      .then(([data, issues]) => { if (active) { setResult({ key: requestKey, data, issues }); setFailure(null) } })
      .catch((cause: unknown) => { if (active) setFailure({ key: requestKey, message: cause instanceof Error ? cause.message : 'Не удалось загрузить хранение' }) })
    return () => { active = false }
  }, [url, requestKey])
  function change(name: string, value: string) {
    const next = new URLSearchParams(params); if (value) next.set(name, value); else next.delete(name)
    if (name !== 'page') next.delete('page')
    setParams(next)
  }
  return <section className="registry-page storage-page">
    <div className="page-header"><h1>Хранение КТК</h1><div className="storage-actions"><button className="secondary-button" onClick={() => setAttempt(a => a + 1)}>Обновить</button>
      <a className="secondary-button" href={'/api/container-storage-periods/export?' + filter}>Выгрузить CSV</a></div></div>
    <form className="storage-filters" onSubmit={e => { e.preventDefault(); change('query', search) }}>
      <label>Номер КТК<UiInput value={search} onChange={e => setDraftSearch({ query, value: e.target.value })} placeholder="Номер КТК" /></label>
      <button className="secondary-button" type="submit">Найти</button>
      {params.size > 0 && <button type="button" className="secondary-button" onClick={() => { setParams({}); setDraftSearch({ query: '', value: '' }) }}>Сбросить</button>}
    </form>
    <p className="composition-hint">Календарные дни, включая день прибытия и вывоза, по московскому времени. Длительность рассчитана на текущую дату.</p>
    {params.has('periodId') && <p>Показан выбранный период хранения.</p>}
    {error && <div role="alert" className="storage-review">{error} <button onClick={() => setAttempt(a => a + 1)}>Повторить</button></div>}
    {!!result?.issues.length && <details className="storage-issues"><summary>Записи истории, требующие проверки: {result.issues.length}</summary>
      <ul>{result.issues.map(issue => <li key={issue.id}><Link to={'/container-owners/' + issue.containerId + '/history'}>{issue.containerName}</Link>: {issue.reason}</li>)}</ul></details>}
    <TableReveal loading={loading}><div className="table-wrap"><StorageTable rows={data?.items || []} emptyText={error ? 'Данные не загружены' : 'Периоды хранения не найдены'} /></div></TableReveal>
    {data && <div className="pagination"><span>Всего: {data.totalElements}</span>{data.totalPages > 1 && <>
      <button disabled={loading || page === 0} onClick={() => change('page', String(page - 1))}>Назад</button><span>{page + 1} / {data.totalPages}</span>
      <button disabled={loading || page + 1 >= data.totalPages} onClick={() => change('page', String(page + 1))}>Далее</button></>}</div>}
  </section>
}
