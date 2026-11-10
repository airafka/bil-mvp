import { useRef, useState } from 'react'
import type { ReferenceOption } from '../domain'
import { UiSelect } from './FormControls'
import './BulkContainerOwnerPicker.css'

export function BulkContainerOwnerPicker({ clients, disabled, selectionActive, hasSelection, onStart, loading, error, onRetry, onApply }: {
  clients: ReferenceOption[]; disabled: boolean; selectionActive: boolean; hasSelection: boolean; onStart: () => void; loading: boolean; error: string
  onRetry: () => void; onApply: (owner: ReferenceOption) => Promise<void>
}) {
  const trigger = useRef<HTMLButtonElement>(null)
  const [selected, setSelected] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const owner = clients.find(client => client.id === selected)
  return <div className="bulk-owner-toolbar">
    {selectionActive && <div className="bulk-owner-field">
      <UiSelect aria-label="Собственник КТК" value={selected} disabled={disabled || saving || loading || !!error || !clients.length} onChange={event => { setSelected(event.target.value); setSaveError('') }}>
        <option value="" hidden disabled />
        {clients.map(client => <option key={client.id} value={client.id}>{client.name}</option>)}
      </UiSelect>
    </div>}
    <button ref={trigger} type="button" className="primary-button" disabled={disabled || saving || (selectionActive && (!hasSelection || !owner || loading || !!error))} onClick={async () => {
      if (!selectionActive) { setSelected(''); setSaveError(''); onStart(); return }
      if (!owner || !hasSelection || saving) return
      setSaving(true); setSaveError('')
      try { await onApply(owner); setSelected(''); requestAnimationFrame(() => trigger.current?.focus()) }
      catch (cause) { setSaveError(cause instanceof Error ? cause.message : 'Не удалось изменить собственника') }
      finally { setSaving(false) }
    }}>{saving ? 'Изменяем…' : 'Изменить собственника'}</button>
    {selectionActive && <>
      {loading ? <div role="status" className="bulk-owner-message">Загрузка…</div> : error ? <div role="alert" className="bulk-owner-message">{error}<button type="button" className="secondary-button" onClick={onRetry}>Повторить</button></div> : !clients.length && <div className="bulk-owner-message">Клиенты не найдены</div>}
      {saveError && <div role="alert" className="bulk-owner-message">{saveError}</div>}
    </>}
  </div>
}
