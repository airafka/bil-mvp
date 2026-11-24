import { useEffect, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router'
import { useApplicationClock } from '../applicationClock'
import { ContainerStatusBadge } from '../components/ContainerStatusBadge'
import { UiInput, UiSelect } from '../components/FormControls'
import { historyOrderPath } from '../containerStock'
import { storageBoundaryLabel, storageDate } from '../containerStorage'
import { containerTypeLabel, type PagedResponse, type ReferenceOption } from '../domain'
import { request } from '../http'

const selectLabels = {
  orderType: 'Тип заявки', orderNumber: 'Номер заявки',
  oldClientId: 'Прежний собственник', newClientId: 'Новый собственник',
}
type SelectField = keyof typeof selectLabels
type Entry = {
  id: string; createdAt: string; occurredAt: string; orderId: string; orderNumber: number; orderType: string
  oldClientName: string | null; newClientName: string | null; oldStatus: string | null; newStatus: string | null
}
type Card = {
  container: ReferenceOption
  history: PagedResponse<Entry>
  options: Record<SelectField, { value: string; label: string }[]>
}

export default function ContainerCardPage() {
  const { containerId = '' } = useParams()
  return <ContainerCard key={containerId} id={containerId} />
}

function ContainerCard({ id }: { id: string }) {
  const { clock } = useApplicationClock()
  const [params, setParams] = useSearchParams()
  const [attempt, setAttempt] = useState(0)
  const url = '/api/containers/' + id + '/card?' + params
  const key = url + '|' + clock.date + '|' + attempt
  const [result, setResult] = useState<{ key: string; card: Card }>()
  const [failure, setFailure] = useState<{ key: string; message: string }>()
  useEffect(() => {
    let active = true
    request<Card>(url).then(card => { if (active) setResult({ key, card }) })
      .catch((error: unknown) => {
        if (active) setFailure({ key, message: error instanceof Error ? error.message : 'Не удалось загрузить карточку КТК' })
      })
    return () => { active = false }
  }, [key, url])
  const container = result?.card.container
  const card = result?.key === key ? result.card : undefined
  const error = !card && failure?.key === key ? failure.message : ''
  const loading = !card && !error

  function change(field: string, value: string) {
    const next = new URLSearchParams(params)
    if (value) next.set(field, value)
    else next.delete(field)
    if (field !== 'page') next.delete('page')
    setParams(next)
  }

  function applyDates(form: HTMLFormElement) {
    const values = new FormData(form)
    const from = String(values.get('createdFrom') ?? '')
    const to = String(values.get('createdTo') ?? '')
    const end = form.elements.namedItem('createdTo') as HTMLInputElement
    end.setCustomValidity(from && to && from > to ? 'Дата окончания раньше даты начала' : '')
    if (!form.reportValidity()) return
    const next = new URLSearchParams(params)
    if (from) next.set('createdFrom', from)
    else next.delete('createdFrom')
    if (to) next.set('createdTo', to)
    else next.delete('createdTo')
    next.delete('page')
    setParams(next)
  }

  function select(field: SelectField) {
    const selected = params.get(field) ?? ''
    const options = result?.card.options[field] ?? []
    return <label className="field horizontal-field"><span>{selectLabels[field]}</span>
      <UiSelect value={selected} disabled={loading} onChange={event => change(field, event.target.value)}>
        <option value="">Все</option>
        {selected && !options.some(option => option.value === selected) && <option value={selected}>Выбранное значение</option>}
        {options.map(option => <option key={option.value} value={option.value}>
          {field === 'orderType' ? storageBoundaryLabel(option.value) : option.label}
        </option>)}
      </UiSelect>
    </label>
  }

  return <section className="form-page">
    <div className="page-header"><h1>{container ? 'КТК ' + container.name : 'Карточка КТК'}</h1>
      <Link className="close-button" to="/containers" aria-label="Закрыть" title="Закрыть">×</Link>
    </div>
    {container && <div className="form-section ui-form-section"><dl className="details-grid">
      <div><dt>Типоразмер</dt><dd>{container.type ? containerTypeLabel(container.type) : '—'}</dd></div>
      <div><dt>Масса тары, кг</dt><dd>{container.tareWeight?.toLocaleString('ru-RU') ?? '—'}</dd></div>
      <div><dt>Грузоподъёмность, кг</dt><dd>{container.loadCapacity?.toLocaleString('ru-RU') ?? '—'}</dd></div>
    </dl></div>}
    <section className="table-card" aria-labelledby="container-history-title">
      <h2 className="form-section-heading" id="container-history-title">История КТК</h2>
      <form className="registry-filters" aria-label="Фильтры истории"
        key={[params.get('createdFrom'), params.get('createdTo')].join('/')}
        onInput={event => (event.currentTarget.elements.namedItem('createdTo') as HTMLInputElement).setCustomValidity('')}
        onSubmit={event => { event.preventDefault(); applyDates(event.currentTarget) }}>
        {select('orderType')}{select('orderNumber')}{select('oldClientId')}{select('newClientId')}
        <label className="field horizontal-field"><span>Дата записи с</span>
          <UiInput type="date" name="createdFrom" defaultValue={params.get('createdFrom') ?? ''} />
        </label>
        <label className="field horizontal-field"><span>Дата записи по</span>
          <UiInput type="date" name="createdTo" defaultValue={params.get('createdTo') ?? ''} />
        </label>
        <div className="filter-actions">
          <button type="submit" className="secondary-button">Применить даты</button>
          <button type="reset" className="secondary-button" onClick={event => {
            const end = event.currentTarget.form?.elements.namedItem('createdTo') as HTMLInputElement | null
            end?.setCustomValidity('')
            setParams({})
          }}>Сбросить</button>
        </div>
      </form>
      {error && <div role="alert">{error} <button className="secondary-button" onClick={() => setAttempt(value => value + 1)}>Повторить</button></div>}
      <div className="table-wrap"><table><thead><tr>
        <th>Дата записи</th><th>Дата операции</th><th>Заявка</th><th>Прежний собственник</th>
        <th>Новый собственник</th><th>Прежнее состояние</th><th>Новое состояние</th>
      </tr></thead><tbody>
        {loading && <tr><td colSpan={7} className="table-message" role="status">Загружаем историю…</td></tr>}
        {card?.history.totalElements === 0 && <tr><td colSpan={7} className="table-message">
          {params.size ? 'По выбранным фильтрам записей нет' : 'Записей истории нет'}
        </td></tr>}
        {card?.history.items.map(row => <tr key={row.id}>
          <td>{storageDate(row.createdAt)}</td><td>{storageDate(row.occurredAt)}</td>
          <td><Link to={historyOrderPath(row)}>{storageBoundaryLabel(row.orderType)} № {row.orderNumber}</Link></td>
          <td>{row.oldClientName ?? '—'}</td><td>{row.newClientName ?? '—'}</td>
          <td><ContainerStatusBadge status={row.oldStatus} /></td><td><ContainerStatusBadge status={row.newStatus} /></td>
        </tr>)}
      </tbody></table></div>
      {card && card.history.totalPages > 1 && <div className="pagination">
        <button aria-label="Предыдущая страница" disabled={card.history.page === 0} onClick={() => change('page', String(card.history.page - 1))}>‹</button>
        <span>{card.history.page + 1} / {card.history.totalPages}</span>
        <button aria-label="Следующая страница" disabled={card.history.page + 1 >= card.history.totalPages} onClick={() => change('page', String(card.history.page + 1))}>›</button>
      </div>}
    </section>
  </section>
}
