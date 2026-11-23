import { useEffect, useState } from 'react'
import { request } from '../http'
import { UiSelect } from './FormControls'

type Owner = { id: string; name: string; available: number }
export function StockOwnerSelect({ type, value, onChange, required = true }: {
  type?: string; value?: string | null; onChange: (value: string) => void; required?: boolean
}) {
  const [owners, setOwners] = useState<Owner[]>([])
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let active = true
    request<Owner[]>('/api/references/container-stock-owners' + (type ? '?type=' + encodeURIComponent(type) : ''))
      .then(rows => { if (active) { setOwners(rows); setError('') } })
      .catch(e => { if (active) { setOwners([]); setError(e instanceof Error ? e.message : 'Не удалось загрузить остатки') } })
    return () => { active = false }
  }, [type, attempt])
  return <><UiSelect aria-label="Собственник КТК" required={required}
    value={value ?? ''} onChange={e => onChange(e.target.value)}>
    <option value="">Выберите собственника</option>
    {owners.map(owner => <option key={owner.id} value={owner.id}>{owner.name} · в остатках {owner.available}</option>)}
  </UiSelect>{error && <span role="alert">{error} <button type="button" onClick={() => setAttempt(x=>x+1)}>Повторить</button></span>}</>
}
