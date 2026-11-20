import { useEffect, useRef, useState } from 'react'
import { request } from '../http'
import { AppOverlay } from './AppOverlay'
import { UiInput } from './FormControls'
import './OperationalReset.css'

type Preview = { token: string; counts: Record<string, number>; totalRows: number }
type Result = { cleared: boolean; backupFile?: string }
const endpoint = '/api/system/operational-reset'
const groups = [
  ['Заявки на поставку', 'receiving_order'], ['Заявки на вывоз', 'shipping_order'],
  ['Заявки на смену собственника', 'service_order'], ['Заявки на услугу', 'comprehensive_service_order'],
  ['Рейсы', 'route'], ['Накладные', 'waybill'], ['Визиты КТК', 'container_visit'],
  ['Назначения собственников', 'container_ownership_period'], ['Остатки КТК', 'container_owner'],
  ['События истории КТК', 'container_owner_history'], ['Начисления', 'billing_charge'], ['Счета', 'payment_invoice'],
] as const

export function OperationalReset() {
  const [enabled, setEnabled] = useState(false)
  const [open, setOpen] = useState(false)
  useEffect(() => { let active = true; void request<{ enabled: boolean }>(endpoint + '/availability').then(result => { if (active) setEnabled(result.enabled) }).catch(() => {}); return () => { active = false } }, [])
  if (!enabled) return null
  return <><button type="button" className="secondary-button operational-reset-trigger" onClick={() => setOpen(true)}>Очистить заявки</button>
    {open && <ResetDialog onClose={() => setOpen(false)} />}</>
}

function ResetDialog({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const lock = useRef(false)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [confirmation, setConfirmation] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [result, setResult] = useState<Result | null>(null)
  useEffect(() => { const el = dialog.current; el?.showModal(); el?.querySelector<HTMLButtonElement>('.close-button')?.focus(); return () => el?.close() }, [])
  useEffect(() => {
    let active = true
    void request<Preview>(endpoint).then(value => { if (active) setPreview(value) }).catch(cause => { if (active) setError(cause instanceof Error ? cause.message : 'Не удалось загрузить данные') }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [])
  async function refresh() {
    setLoading(true); setPreview(null); setConfirmation(''); setError('')
    try { setPreview(await request<Preview>(endpoint)) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось загрузить данные') }
    finally { setLoading(false) }
  }
  const close = () => { if (result?.cleared) window.location.assign('/container-storage'); else onClose() }
  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (lock.current || !preview || confirmation !== 'УДАЛИТЬ') return
    lock.current = true; setBusy(true); setError('')
    try { setResult(await request<Result>(endpoint, { method: 'POST', body: JSON.stringify({ confirmation, token: preview.token }) })) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось очистить данные'); setPreview(null); setConfirmation('') }
    finally { lock.current = false; setBusy(false) }
  }
  return <AppOverlay><dialog ref={dialog} className="route-side-dialog operational-reset-dialog" aria-labelledby="reset-title" onCancel={event => { event.preventDefault(); if (!busy) close() }}>
    <form onSubmit={submit}>
      <header className="route-dialog-heading"><h2 id="reset-title">Очистка заявок и хранения</h2><div className="header-actions">
        {!result && <button type="submit" className="primary-button operational-reset-confirm" disabled={busy || loading || !preview?.totalRows || confirmation !== 'УДАЛИТЬ'}>{busy ? 'Очищаем…' : 'Удалить данные'}</button>}
        {result && <button type="button" className="primary-button" onClick={close}>Готово</button>}
        <button type="button" className="close-button" aria-label="Закрыть очистку" disabled={busy} onClick={close}>×</button>
      </div></header>
      <div className="route-drawer-body" aria-busy={busy || loading}>
        {result ? <div role="status"><p>{result.cleared ? 'Заявки и хранение очищены. Справочники и настройки сохранены.' : 'Данных для удаления уже нет.'}</p>
          {result.backupFile && <><p>Резервная копия сохранена в папке backups/ui-resets проекта. Для восстановления обратитесь к разработчику.</p><p className="operational-reset-backup">{result.backupFile}</p></>}
        </div> : <>
          <p>Будут удалены все заявки и их состав, рейсы, накладные, остатки КТК, визиты, смены собственника, история, начисления и счета. Отчёт хранения станет пустым.</p>
          <p>Клиенты, договоры, тарифы, справочники КТК и вагонов, транспорт, рабочая дата и нумерация документов сохранятся.</p>
          <p>Перед удалением автоматически сохраняется резервная копия. Если сохранить её не удастся, очистка не начнётся.</p>
          {loading && <p role="status">Проверяем данные…</p>}
          {preview && <><dl className="operational-reset-counts">{groups.map(([label, table]) => <div key={table}><dt>{label}</dt><dd>{preview.counts[table]?.toLocaleString('ru-RU') ?? 0}</dd></div>)}</dl>
            {preview.totalRows > 0 ? <label className="field"><span>Для подтверждения введите УДАЛИТЬ</span><UiInput value={confirmation} onChange={event => setConfirmation(event.target.value)} disabled={busy} autoComplete="off" spellCheck={false} /></label> : <p>Заявки и хранение уже пусты.</p>}</>}
          {busy && <p role="status">Сохраняем копию и очищаем данные. Дождитесь результата.</p>}
          {error && <p role="alert" className="error-message">{error}</p>}
          {!preview && !loading && !busy && <button type="button" className="secondary-button" onClick={() => { void refresh() }}>Обновить список</button>}
        </>}
      </div>
    </form>
  </dialog></AppOverlay>
}
