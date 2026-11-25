import { TableReveal } from '../components/TableReveal'
import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { RecordRow } from '../components/RecordRow'
import { Notification } from '../components/Notification'
import { ActionIcon } from '../components/ActionIcon'
import { RowActions } from '../components/RowActions'
import { UiInput, UiSelect, UiTextarea } from '../components/FormControls'
import { getReferenceOptions, getOwnershipOrders, getOwnershipOrder, createOwnershipOrder, updateOwnershipOrder, getOwnershipAvailable, getOwnershipAvailableForCreate, acceptOwnershipOrder, cancelOwnershipOrder, deleteOwnershipOrder, resendOutboundData } from '../api'
import { businessDateLabel, shiftBusinessDate, useApplicationClock } from '../applicationClock'
import { historyOrderPath, type OwnershipContainer, type OwnershipDetails, type OwnershipHeader, type OwnershipVisitPeriod } from '../containerStock'
import { containerTypeLabel, type PagedResponse, type ReferenceOption } from '../domain'
import { ContainerStatusBadge } from '../components/ContainerStatusBadge'
import '../ownership-order.css'

const resultLabels: Record<string, string> = { PLANNED: 'Передача запланирована', APPLIED: 'Передача выполнена', SKIPPED: 'Передача не выполнена', CANCELLED: 'Передача отменена', BLOCKED: 'Требует проверки' }
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)
const completedAt = (value: string | null) => value ? new Date(value).toLocaleString('ru-RU', { timeZone: 'UTC' }) : '—'
function OwnershipStatus({ status }: { status: string }) {
  return <span className={'ownership-status ' + (status === 'DONE' ? 'ownership-status-done' : status === 'SCHEDULED' ? 'ownership-status-scheduled' : '')}>{status === 'DONE' ? 'Выполнено' : status === 'SCHEDULED' ? 'Ожидает выполнения' : status === 'CANCELLED' ? 'Отменено' : 'Черновик'}</span>
}
function CloseLink() {
  return <Link className="close-button" to="/service-orders" aria-label="Закрыть" title="Закрыть"><ActionIcon name="close" /></Link>
}
function OwnershipTabs({ tab, change, disabled = false }: { tab: string; change: (tab: 'main' | 'containers') => void; disabled?: boolean }) {
  return <div className="stepper view-tabs" role="tablist" aria-label="Разделы смены собственника КТК">
    <button type="button" role="tab" aria-selected={tab === 'main'} className={'step ' + (tab === 'main' ? 'current' : '')} disabled={disabled} onClick={() => change('main')}>Основное</button>
    <button type="button" role="tab" aria-selected={tab === 'containers'} className={'step ' + (tab === 'containers' ? 'current' : '')} disabled={disabled} onClick={() => change('containers')}>КТК</button>
  </div>
}
function Pagination({ data, change }: { data: PagedResponse<unknown>; change: (page: number) => void }) {
  return data.totalPages > 1 && <div className="pagination"><button disabled={!data.page} onClick={() => change(data.page - 1)}>Назад</button><span>{data.page + 1} / {data.totalPages}</span><button disabled={data.page + 1 >= data.totalPages} onClick={() => change(data.page + 1)}>Далее</button></div>
}

export function OwnershipOrderRegistryPage() {
  const { clock } = useApplicationClock()
  const [data, setData] = useState<PagedResponse<OwnershipHeader> | null>(null)
  const [page, setPage] = useState(0), [error, setError] = useState('')
  const [deleting, setDeleting] = useState<OwnershipHeader | null>(null), [busy, setBusy] = useState(false), [revision, setRevision] = useState(0)
  const [message, setMessage] = useState('')
  useEffect(() => { let active = true; getOwnershipOrders('', page).then(v => { if (active) setData(v) }).catch(e => { if (active) setError(errorText(e)) }); return () => { active = false } }, [page, revision, clock.date])
  const hasScheduled = data?.items.some(row => row.status === 'SCHEDULED')
  useEffect(() => {
    if (!hasScheduled || busy || deleting) return
    const timer = window.setInterval(() => { if (!document.hidden) setRevision(value => value + 1) }, 5000)
    return () => window.clearInterval(timer)
  }, [hasScheduled, busy, deleting])
  async function remove() {
    if (!deleting || busy) return
    setBusy(true); setError('')
    try { await deleteOwnershipOrder(deleting.id); setDeleting(null); setData(null); setPage(0); setRevision(v => v + 1); setMessage('Заявка удалена') }
    catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }
  return <section className="registry-page ownership-page">
    <div className="page-header"><h1>Смена собственника КТК</h1><div className="header-actions"><Link className="secondary-button" to="/container-owners">К остаткам</Link><Link className="primary-button create-action-button" to="/service-orders/new"><ActionIcon name="plus" /> Создать</Link></div></div>
    {error && <Notification kind="error">{error}</Notification>}{message && <Notification kind="success">{message}</Notification>}
    <TableReveal loading={!data && !error}>
      <div className="table-wrap"><table className="ownership-registry-table"><thead><tr><th className="registry-index">№</th><th>Номер заявки</th><th>Новый собственник</th><th>Количество КТК</th><th>Статус</th><th>Дата передачи</th><th>Подтверждено (UTC)</th><th>Комментарий</th><th className="registry-actions" aria-label="Действия" /></tr></thead><tbody>
        {!data && !error && <tr><td colSpan={9}>Загружаем заявки…</td></tr>}{data?.items.length === 0 && <tr><td colSpan={9}>Заявок пока нет</td></tr>}
        {data?.items.map((row, index) => <RecordRow to={'/service-orders/' + row.id} key={row.id}><td className="registry-index">{data.page * data.size + index + 1}</td><td><Link className="order-code" to={'/service-orders/' + row.id}>{row.number}</Link></td><td>{row.clientName}</td><td>{row.containerQuantity}</td><td><OwnershipStatus status={row.status} /></td><td>{row.effectiveDate ? businessDateLabel(row.effectiveDate) : '—'}</td><td>{completedAt(row.completionAt)}</td><td>{row.comment || '—'}</td><td className="registry-actions"><RowActions label={'Действия с заявкой ' + row.number} disabled={busy} actions={[{ label: 'Открыть', to: '/service-orders/' + row.id }, ...(row.status === 'DRAFT' ? [{ label: 'Изменить', to: '/service-orders/' + row.id + '?edit=1' }, { label: 'Удалить', onClick: () => setDeleting(row) }] : [])]} /></td></RecordRow>)}
      </tbody></table></div>{data && <Pagination data={data} change={value => { setPage(value); setData(null) }} />}
    </TableReveal>
    {deleting && <div className="modal-backdrop"><div className="ownership-delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby="ownership-delete-title"><h2 id="ownership-delete-title">Удалить заявку {deleting.number}?</h2><p>Черновик будет удалён, выбранные КТК освободятся для других заявок.</p><div className="ownership-delete-dialog-actions"><button className="secondary-button" disabled={busy} onClick={() => setDeleting(null)}>Отмена</button><button className="primary-button" disabled={busy} onClick={remove}>{busy ? 'Удаляем…' : 'Удалить'}</button></div></div></div>}
  </section>
}

export function OwnershipOrderCreatePage() {
  const { clock } = useApplicationClock()
  const [enteredDate, setEnteredDate] = useState<string>()
  const [isDeferred, setDeferred] = useState(false)
  const tomorrow = shiftBusinessDate(clock.date, 1)
  const effectiveDate = enteredDate ?? clock.date
  const [sourceClient, setSourceClient] = useState('')
  const [clients, setClients] = useState<ReferenceOption[]>([]), [client, setClient] = useState(''), [comment, setComment] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [tab, setTab] = useState<'main' | 'containers'>('main')
  const [page, setPage] = useState(0)
  const [available, setAvailable] = useState<PagedResponse<OwnershipContainer> | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [selectionDate, setSelectionDate] = useState(effectiveDate)
  function clearSelection() { setSelected(new Set()); setAvailable(null); setPage(0) }
  if (selectionDate !== effectiveDate) {
    setSelectionDate(effectiveDate)
    clearSelection()
  }
  useEffect(() => {
    if (tab !== 'containers' || !sourceClient || !client || !effectiveDate) return
    let active = true
    getOwnershipAvailableForCreate(client, '', page, effectiveDate, sourceClient)
      .then(value => { if (active) setAvailable(value) })
      .catch(e => { if (active) setError(errorText(e)) })
    return () => { active = false }
  }, [tab, sourceClient, client, page, clock.date, effectiveDate])
  function checkFields() {
    if (!sourceClient) setError('Выберите прежнего собственника КТК')
    else if (!client) setError('Выберите нового собственника КТК')
    else if (client === sourceClient) setError('Прежний и новый собственники должны различаться')
    else if (!effectiveDate) setError('Укажите дату передачи')
    else if (isDeferred !== (effectiveDate > clock.date)) setError(isDeferred ? 'Выберите будущую дату передачи' : 'Выберите сегодняшнюю или прошедшую дату передачи')
    else return true
    setTab('main')
    return false
  }
  function changeTab(value: 'main' | 'containers') {
    if (value === 'containers' && !checkFields()) return
    setError(''); setTab(value)
  }
  const lock = useRef(false), navigate = useNavigate()
  useEffect(() => { let active = true; getReferenceOptions('clients').then(v => { if (active) setClients(v) }).catch(e => { if (active) setError(errorText(e)) }); return () => { active = false } }, [])
  async function create() {
    if (lock.current) return
    if (!checkFields()) return
    lock.current = true; setBusy(true); setError('')
    try { const result = await createOwnershipOrder(client, comment, [...selected], effectiveDate, sourceClient, isDeferred); navigate('/service-orders/' + result.order.id) }
    catch (e) { setError(errorText(e)) } finally { lock.current = false; setBusy(false) }
  }
  return <section className="form-page ownership-page"><div className="page-header"><h1>Новая смена собственника КТК</h1><div className="header-actions"><CloseLink /><button className={tab === 'main' ? 'primary-button' : 'secondary-button'} disabled={busy} onClick={() => changeTab(tab === 'main' ? 'containers' : 'main')}>{tab === 'main' ? 'Далее →' : '← Назад'}</button>{tab === 'containers' && <button className="primary-button" disabled={busy} onClick={create}>{busy ? 'Сохраняем…' : 'Создать'}</button>}</div></div>
    {error && <Notification kind="error">{error}</Notification>}
    <div className="form-workspace"><div className="ownership-tabs-toolbar"><OwnershipTabs tab={tab} change={changeTab} disabled={busy} /></div>
      {tab === 'main' && <>
      <section className="form-section ui-form-section"><div className="form-section-heading"><h2>Основная информация</h2></div>
        <div className="form-fields-grid"><div className="form-fields-column">
          <label className="field horizontal-field"><span>Номер заявки</span><UiInput value="" readOnly /></label>
          <label className="field horizontal-field"><span>Количество КТК</span><UiInput value={selected.size} readOnly /></label>
          <label className="field horizontal-field"><span>Прежний собственник <b>*</b></span><UiSelect required disabled={busy} value={sourceClient} onChange={e => {
            const id = e.target.value
            setSourceClient(id)
            if (client === id) setClient('')
            clearSelection(); setError('')
          }}><option value="" hidden disabled />{clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</UiSelect></label>
          <label className="field horizontal-field"><span>Новый собственник <b>*</b></span><UiSelect required disabled={busy} value={client} onChange={e => { setClient(e.target.value); clearSelection(); setError('') }}><option value="" hidden disabled />{clients.filter(c => c.id !== sourceClient).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</UiSelect></label>
          <label className="field horizontal-field"><span>Операция</span><UiInput value="Смена собственника КТК" readOnly /></label>
          <label className="field horizontal-field"><span>Дата будущая</span><UiInput type="checkbox" checked={isDeferred} disabled={busy} onChange={e => { setDeferred(e.target.checked); setEnteredDate(e.target.checked ? tomorrow : clock.date); setError('') }} /></label>
          <label className="field horizontal-field"><span>Дата передачи <b>*</b></span><UiInput type="date" required min={isDeferred ? tomorrow : undefined} max={isDeferred ? "9999-12-31" : clock.date} disabled={busy} value={effectiveDate} onChange={e => { setEnteredDate(e.target.value); setError('') }} /></label>
        </div><div className="form-fields-column"><div className="field horizontal-field"><span>Статус</span><div className="ownership-status-field"><OwnershipStatus status="DRAFT" /></div></div></div></div>
      </section>
      <section className="form-section ui-form-section"><div className="form-section-heading"><h2>Дополнительная информация</h2></div><label className="field horizontal-field ownership-comment"><span>Комментарий</span><UiTextarea disabled={busy} maxLength={1000} value={comment} onChange={e => setComment(e.target.value)} placeholder="Введите комментарий" /></label></section>
      </>}
      {tab === 'containers' && <><OwnershipContainerTable rows={available?.items ?? []} loading={!available} selected={selected} busy={busy} onToggle={(id, checked) => setSelected(previous => { const next = new Set(previous); if (checked) next.add(id); else next.delete(id); return next })} />{available && <Pagination data={available} change={value => { setPage(value); setAvailable(null) }} />}</>}
    </div>
  </section>
}

export function OwnershipOrderViewPage() {
  const { clock } = useApplicationClock()
  const [effectiveDate, setEffectiveDate] = useState('')
  const [isDeferred, setDeferred] = useState(false)
  const [confirmCancel, setConfirmCancel] = useState(false)
  const tomorrow = shiftBusinessDate(clock.date, 1)
  const { ownershipOrderId = '' } = useParams()
  const [client, setClient] = useState(''), [clients, setClients] = useState<ReferenceOption[]>([])
  const [params, setParams] = useSearchParams()
  const editingRequested = params.get('edit') === '1'
  const tab = params.get('tab') === 'containers' ? 'containers' : 'main'
  const [data, setData] = useState<OwnershipDetails | null>(null), [comment, setComment] = useState(''), [page, setPage] = useState(0)
  const [available, setAvailable] = useState<PagedResponse<OwnershipContainer> | null>(null), [selected, setSelected] = useState<Set<string>>(new Set())
  const [error, setError] = useState(''), [message, setMessage] = useState(''), [busy, setBusy] = useState(false), [revision, setRevision] = useState(0)
  const lock = useRef(false)
  const loadedOrderId = useRef('')
  function apply(value: OwnershipDetails) { loadedOrderId.current = value.order.id; setData(value); setClient(value.order.clientId); setDeferred(value.order.isDeferred); setEffectiveDate(value.order.effectiveDate || ''); setComment(value.order.comment || ''); setSelected(new Set(value.containers.map(c => c.containerOwnerId))) }
  useEffect(() => {
    if (busy || (editingRequested && loadedOrderId.current === ownershipOrderId)) return
    let active = true
    getOwnershipOrder(ownershipOrderId).then(v => { if (active) apply(v) }).catch(e => { if (active) setError(errorText(e)) })
    return () => { active = false }
  }, [ownershipOrderId, clock.date, editingRequested, busy])
  const draft = data?.order.status === 'DRAFT', editing = draft && editingRequested
  useEffect(() => {
    if (!editing) return
    let active = true
    getReferenceOptions('clients').then(value => { if (active) setClients(value) }).catch(e => { if (active) setError(errorText(e)) })
    return () => { active = false }
  }, [editing])
  const awaitingDelivery = !!data?.order.exportQueued && !data.order.exportSentAt && !data.order.exportExhausted
  useEffect(() => {
    if ((data?.order.status !== 'SCHEDULED' && !awaitingDelivery) || busy) return
    let active = true
    const refresh = () => { if (!document.hidden) getOwnershipOrder(ownershipOrderId).then(value => { if (active) { apply(value); if (data?.order.status === 'SCHEDULED' && value.order.status === 'DONE') setMessage('Смена собственника выполнена.') } }).catch(e => { if (active) setError(errorText(e)) }) }
    const timer = window.setInterval(refresh, 5000)
    return () => { active = false; window.clearInterval(timer) }
  }, [ownershipOrderId, data?.order.status, awaitingDelivery, busy])
  useEffect(() => { if (!editing || !effectiveDate || !client) return; let active = true; getOwnershipAvailable(ownershipOrderId, '', page, effectiveDate, client).then(v => { if (active) setAvailable(v) }).catch(e => { if (active) setError(errorText(e)) }); return () => { active = false } }, [ownershipOrderId, editing, page, revision, clock.date, effectiveDate, client])
  function clearSelection() { setSelected(new Set()); setAvailable(null); setPage(0); setError('') }
  function changeTab(value: 'main' | 'containers') { if (editing && value === 'containers' && !effectiveDate) { setError('Укажите дату передачи'); return }; setParams({ ...(editing ? { edit: '1' } : {}), ...(value === 'containers' ? { tab: value } : {}) }, { replace: true }) }
  function finishEditing() { setParams(tab === 'containers' ? { tab } : {}, { replace: true }); setAvailable(null); setPage(0) }
  async function save(accept: boolean) {
    if (lock.current) return
    if (editing && !effectiveDate) { setError('Укажите дату передачи'); return }
    if (editing && isDeferred !== (effectiveDate > clock.date)) { setError(isDeferred ? 'Выберите будущую дату передачи' : 'Выберите сегодняшнюю или прошедшую дату передачи'); return }
    if (editing && (!client || client === data?.order.sourceClientId)) { setError('Выберите нового собственника, отличного от прежнего'); return }
    lock.current = true; setBusy(true); setError(''); setMessage('')
    try {
      const result = accept
        ? await acceptOwnershipOrder(ownershipOrderId)
        : await updateOwnershipOrder(ownershipOrderId, comment, effectiveDate, { clientId: client, isDeferred, containerOwnerIds: [...selected] })
      apply(result); finishEditing(); setRevision(v => v + 1); setMessage(accept ? (result.order.status === 'DONE' ? 'Смена собственника выполнена.' : 'Заявка ожидает выполнения.') : 'Заявка сохранена')
    } catch (e) { setError(errorText(e)) } finally { lock.current = false; setBusy(false) }
  }
  async function resend() {
    if (lock.current || !data?.order.outboundDataId) return
    lock.current = true; setBusy(true); setError(''); setMessage('')
    try {
      await resendOutboundData(data.order.outboundDataId)
      apply(await getOwnershipOrder(ownershipOrderId))
      setMessage('Пакет поставлен в очередь на повторную отправку.')
    } catch (e) { setError(errorText(e)) } finally { lock.current = false; setBusy(false) }
  }
  async function cancel() {
    if (lock.current) return
    lock.current = true; setBusy(true); setError(''); setMessage('')
    try { apply(await cancelOwnershipOrder(ownershipOrderId)); setConfirmCancel(false); setMessage('Заявка отменена') }
    catch (e) { setError(errorText(e)) } finally { lock.current = false; setBusy(false) }
  }
  function toggle(id: string, checked: boolean) { setSelected(previous => { const next = new Set(previous); if (checked) next.add(id); else next.delete(id); return next }) }
  if (!data) return <section className="form-page"><div className="page-header"><h1>Смена собственника КТК</h1><CloseLink /></div>{error ? <Notification kind="error">{error}</Notification> : <p role="status">Загружаем заявку…</p>}</section>
  const rows = editing ? available?.items ?? [] : data.containers
  return <section className="form-page ownership-page"><div className="page-header"><h1>Смена собственника КТК №{data.order.number}</h1><div className="header-actions">
    {editing ? <><button className="secondary-button" disabled={busy} onClick={() => { apply(data); finishEditing(); setError('') }}>Отмена</button>{tab === 'containers' && <button className="secondary-button" disabled={busy} onClick={() => changeTab('main')}>← Назад</button>}<button className="primary-button" disabled={busy} onClick={() => save(false)}>{busy ? 'Сохраняем…' : 'Сохранить'}</button>{tab === 'main' && <button className="primary-button" disabled={busy} onClick={() => changeTab('containers')}>Далее →</button>}</> : draft && <><button type="button" className="secondary-button icon-button" aria-label="Редактировать" title="Редактировать" disabled={busy} onClick={() => { setParams({ edit: '1', ...(tab === 'containers' ? { tab } : {}) }, { replace: true }); setMessage('') }}><ActionIcon name="edit" /></button><button className="primary-button" disabled={busy || !data.containers.length} onClick={() => save(true)}>{busy ? 'Подтверждаем…' : 'Подтвердить'}</button></>}
    {data.order.status === 'SCHEDULED' && <button className="secondary-button" disabled={busy} onClick={() => setConfirmCancel(true)}>Отменить заявку</button>}<CloseLink />
  </div></div>
    {error && <Notification kind="error">{error}</Notification>}{message && <Notification kind="success">{message}</Notification>}
    {confirmCancel && <div className="modal-backdrop"><div className="ownership-delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby="cancel-transfer-title"><h2 id="cancel-transfer-title">Отменить заявку №{data.order.number}?</h2><p>Для новой передачи потребуется создать другую заявку.</p><div className="ownership-delete-dialog-actions"><button className="secondary-button" disabled={busy} onClick={() => setConfirmCancel(false)}>Закрыть</button><button className="primary-button" disabled={busy} onClick={cancel}>Отменить заявку</button></div></div></div>}
    <div className="form-workspace"><div className="ownership-tabs-toolbar"><OwnershipTabs tab={tab} change={changeTab} disabled={busy} />{editing && tab === 'containers' && selected.size > 0 && <button type="button" className="secondary-button" disabled={busy} onClick={() => setSelected(new Set())}>Снять выбор КТК</button>}</div>
      {tab === 'main' && <><section className="form-section ui-form-section"><div className="form-section-heading"><h2>Основная информация</h2></div><dl className="details-grid">
        <div><dt>Номер заявки</dt><dd>{data.order.number}</dd></div><div><dt>Статус</dt><dd><OwnershipStatus status={data.order.status} /></dd></div>
        {data.order.executionError && <div><dt>Причина ожидания</dt><dd>{data.order.executionError}</dd></div>}
        {data.order.exportQueued && <div><dt>Пакет TOS</dt><dd>{data.order.status === 'SCHEDULED' ? 'Ожидает смены собственника в остатках' : data.order.exportSentAt ? 'Принят Datareon ' + completedAt(data.order.exportSentAt) + ' UTC' : data.order.exportError?.replace(/\. Отправка будет повторена\.$/, '') || 'В очереди на отправку'}
          {data.order.exportExhausted && <><span> Автоматические попытки исчерпаны. </span><button className="secondary-button" disabled={busy} onClick={resend}>Повторить отправку</button></>}
        </dd></div>}
        <div><dt>Количество КТК</dt><dd>{editing ? selected.size : data.order.containerQuantity}</dd></div><div><dt>Подтверждено (UTC)</dt><dd>{completedAt(data.order.completionAt)}</dd></div>
        <div><dt><label htmlFor="ownership-deferred">Дата будущая</label></dt><dd>{editing ? <UiInput id="ownership-deferred" type="checkbox" checked={isDeferred} disabled={busy} onChange={e => { setDeferred(e.target.checked); setEffectiveDate(e.target.checked ? tomorrow : clock.date); clearSelection() }} /> : data.order.isDeferred ? 'Да' : 'Нет'}</dd></div>
        <div><dt><label htmlFor="ownership-effective-date">Дата передачи</label></dt><dd>{editing ? <UiInput id="ownership-effective-date" type="date" required min={isDeferred ? tomorrow : undefined} max={isDeferred ? "9999-12-31" : clock.date} disabled={busy} value={effectiveDate} onChange={e => { setEffectiveDate(e.target.value); clearSelection() }} /> : data.order.effectiveDate ? businessDateLabel(data.order.effectiveDate) : '—'}</dd></div>
        <div><dt>Прежний собственник</dt><dd>{data.order.sourceClientName || '—'}</dd></div>
        <div><dt><label htmlFor="ownership-new-client">Новый собственник</label></dt><dd>{editing ? <UiSelect id="ownership-new-client" required disabled={busy} value={client} onChange={e => { setClient(e.target.value); clearSelection() }}>
          {client === data.order.clientId && !clients.some(c => c.id === client) && <option value={client}>{data.order.clientName}</option>}
          {clients.filter(c => c.id !== data.order.sourceClientId).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </UiSelect> : data.order.clientName}</dd></div><div className="ownership-service-field"><dt>Операция</dt><dd>Смена собственника КТК</dd></div>
      </dl></section><section className="form-section ui-form-section"><div className="form-section-heading"><h2>Дополнительная информация</h2></div>{editing ? <label className="field horizontal-field ownership-comment"><span>Комментарий</span><UiTextarea disabled={busy} value={comment} maxLength={1000} onChange={e => setComment(e.target.value)} placeholder="Введите комментарий" /></label> : <dl className="details-grid"><div className="details-wide"><dt>Комментарий</dt><dd className="ownership-comment-text">{data.order.comment || '—'}</dd></div></dl>}</section></>}
      {tab === 'containers' && <><OwnershipContainerTable rows={rows} loading={Boolean(editing && !available)} selected={editing ? selected : undefined} busy={busy} onToggle={editing ? toggle : undefined} />{editing && available && <Pagination data={available} change={value => { setPage(value); setAvailable(null) }} />}</>}
    </div>

  </section>
}

function VisitPeriodCell({ periods }: { periods: OwnershipVisitPeriod[] }) {
  return <td>{periods.length ? periods.map(period => <div className="ownership-visit-period" key={period.orderId}>
    <time dateTime={period.occurredAt}>{businessDateLabel(period.date)}</time>{' · '}
    <Link to={historyOrderPath(period)}>№ {period.orderNumber}</Link>
    <div>{period.ownerName}</div>
  </div>) : '—'}</td>
}

function OwnershipContainerTable({ rows, loading, selected, busy, onToggle }: { rows: OwnershipContainer[]; loading: boolean; selected?: Set<string>; busy: boolean; onToggle?: (id: string, checked: boolean) => void }) {
  const previewDialog = useRef<HTMLDialogElement>(null)
  const [preview, setPreview] = useState<OwnershipContainer | null>(null)
  function showPreview(row: OwnershipContainer) { setPreview(row); previewDialog.current?.showModal() }
  const selectable = Boolean(onToggle)
  return <><div className="table-wrap"><table className="ownership-container-table"><thead><tr><th className="registry-index">{selectable ? '' : '№'}</th><th>КТК</th><th>Поставка</th><th>Выполненные передачи</th><th>Запланированные передачи</th><th className="registry-actions" aria-label="Действия" /></tr></thead><tbody>
        {selectable && loading && <tr><td colSpan={6}>Загружаем доступные КТК…</td></tr>}{rows.length === 0 && (!loading) && <tr><td colSpan={6}>{selectable ? 'Доступных КТК не найдено' : 'КТК не выбраны'}</td></tr>}
        {rows.map((row, index) => <tr key={row.containerId}><td className="registry-index">{selectable ? <UiInput aria-label={'Выбрать КТК ' + row.containerName} type="checkbox" disabled={busy} checked={selected?.has(row.containerOwnerId)} onChange={e => onToggle?.(row.containerOwnerId, e.target.checked)} /> : index + 1}</td><td><button type="button" className="link-button" onClick={() => showPreview(row)}>{row.containerName}</button>{!selectable && row.resultStatus && row.resultStatus !== 'DRAFT' && <div>{resultLabels[row.resultStatus] ?? row.resultStatus}{row.resultReason && <p>{row.resultReason}</p>}</div>}</td>
          <VisitPeriodCell periods={row.visitPeriods.filter(period => period.orderType === 'RECEIVING_ORDER')} />
          <VisitPeriodCell periods={row.visitPeriods.filter(period => period.transferStatus === 'APPLIED')} />
          <VisitPeriodCell periods={row.visitPeriods.filter(period => period.transferStatus === 'PLANNED')} />
          <td className="registry-actions"><RowActions label={'Действия с КТК ' + row.containerName} actions={[{ label: 'Предпросмотр', onClick: () => showPreview(row) }, { label: 'История собственников', to: '/container-owners/' + row.containerId + '/history' }]} /></td></tr>)}
      </tbody></table></div>
    <dialog ref={previewDialog} className="ownership-preview" aria-labelledby="ownership-preview-title">
      <div className="page-header"><h2 id="ownership-preview-title">КТК {preview?.containerName}</h2><button type="button" className="close-button" aria-label="Закрыть предпросмотр" onClick={() => previewDialog.current?.close()}><ActionIcon name="close" /></button></div>
      {preview && <dl className="details-grid"><div><dt>Номер КТК</dt><dd>{preview.containerName}</dd></div><div><dt>Тип</dt><dd>{containerTypeLabel(preview.containerType as Parameters<typeof containerTypeLabel>[0])}</dd></div><div><dt>{selectable ? 'Собственник на дату передачи' : 'Текущий собственник'}</dt><dd>{preview.clientName || '—'}</dd></div><div><dt>Состояние</dt><dd><ContainerStatusBadge status={preview.status} /></dd></div></dl>}
    </dialog></>
}
