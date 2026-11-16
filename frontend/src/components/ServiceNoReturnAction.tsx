import { useEffect, useRef, useState } from 'react'
import { getNoReturnCandidates, selectNoReturnContainers, type NoReturnCandidate } from '../api'
import type { ComprehensiveServiceOrderDetails } from '../comprehensiveServiceOrder'
import { AppOverlay } from './AppOverlay'
import { UiInput } from './FormControls'

export function ServiceNoReturnAction({ serviceId, disabled, onSaved, onError }: {
  serviceId: string; disabled: boolean
  onSaved: (result: ComprehensiveServiceOrderDetails) => void; onError: (message: string) => void
}) {
  const [open, setOpen] = useState(false)
  return <>
    <button type="button" className="secondary-button" disabled={disabled} onClick={() => { onError(''); setOpen(true) }}>Возврат не нужен</button>
    {open && <NoReturnDialog serviceId={serviceId} onClose={() => setOpen(false)} onSaved={result => { setOpen(false); onSaved(result) }} />}
  </>
}

function NoReturnDialog({ serviceId, onClose, onSaved }: {
  serviceId: string; onClose: () => void; onSaved: (result: ComprehensiveServiceOrderDetails) => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const lock = useRef(false)
  const [rows, setRows] = useState<NoReturnCandidate[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { dialog.current?.showModal() }, [])
  useEffect(() => {
    let active = true
    getNoReturnCandidates(serviceId).then(value => { if (active) setRows(value) })
      .catch(cause => { if (active) setLoadError(cause instanceof Error ? cause.message : 'Не удалось загрузить КТК') })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [serviceId, attempt])
  const available = rows.filter(row => row.returnRequired)
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); event.stopPropagation()
    if (lock.current || loading || loadError || !selected.length) return
    lock.current = true; setBusy(true); setError('')
    try { onSaved(await selectNoReturnContainers(serviceId, selected)) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось сохранить выбор') }
    finally { lock.current = false; setBusy(false) }
  }
  return <AppOverlay><dialog ref={dialog} className="route-side-dialog return-dialog" aria-labelledby="no-return-title" onCancel={event => { event.preventDefault(); if (!busy) onClose() }}>
    <form onSubmit={submit}>
      <header className="route-dialog-heading"><h2 id="no-return-title">Возврат не нужен</h2><div className="header-actions">
        <button type="submit" className="primary-button" disabled={busy || loading || !!loadError || !selected.length}>{busy ? 'Сохраняем…' : 'Сохранить'}</button>
        <button type="button" className="close-button" aria-label="Закрыть выбор КТК без возврата" disabled={busy} onClick={onClose}>×</button>
      </div></header>
      <div className="route-drawer-body">
        {loading && <p role="status">Загружаем КТК…</p>}
        {loadError && <div role="alert"><p>{loadError}</p><button type="button" className="secondary-button" onClick={() => { setLoading(true); setLoadError(''); setAttempt(value => value + 1) }}>Повторить</button></div>}
        {!loading && !loadError && <>
          {!available.length && <p role="status">Нет КТК для выбора: возвраты уже оформлены, отмечены как ненужные или отсутствуют активные автовывозы.</p>}
          {rows.length > 0 && <div className="table-wrap return-container-scroll"><table className="return-container-table" data-responsive-min-width={300} aria-label="КТК без возврата">
            <colgroup><col style={{ width: 44 }} /><col /></colgroup>
            <thead><tr><th scope="col" className="composition-index"><UiInput type="checkbox" aria-label="Выбрать все КТК без возврата" autoFocus disabled={busy || !available.length} checked={available.length > 0 && selected.length === available.length} ref={element => { if (element) element.indeterminate = selected.length > 0 && selected.length < available.length }} onChange={event => setSelected(event.target.checked ? available.map(row => row.containerId) : [])} /></th><th scope="col">Номер КТК</th></tr></thead>
            <tbody>{rows.map(row => <tr key={row.containerId}>
              <td className="composition-index"><UiInput type="checkbox" aria-label={`Выбрать КТК ${row.containerName}`} disabled={busy || !row.returnRequired} checked={!row.returnRequired || selected.includes(row.containerId)} onChange={event => setSelected(value => event.target.checked ? [...value, row.containerId] : value.filter(id => id !== row.containerId))} /></td>
              <td>{row.containerName}</td>
            </tr>)}</tbody>
          </table></div>}
        </>}
        {error && <p role="alert">{error}</p>}
      </div>
    </form>
  </dialog></AppOverlay>
}
