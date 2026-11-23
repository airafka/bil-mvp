import { useState } from 'react'
import { request } from '../http'
import { StockOwnerSelect } from './StockOwnerSelect'

export function ShipmentPlanOwner({orderId,rowId,ownerId,type,onSaved}:{
  orderId:string; rowId:string; ownerId?:string|null; type?:string|null; onSaved:()=>Promise<void>
}) {
  const [owner,setOwner]=useState(ownerId ?? '')
  const [busy,setBusy]=useState(false)
  const [error,setError]=useState('')
  async function save() {
    setBusy(true);setError('')
    try {
      await request('/api/shipping-orders/'+orderId+'/plan/containers/'+rowId+'/owner',{
        method:'PUT',body:JSON.stringify({ownerId:owner})})
      await onSaved()
    } catch(e){setError(e instanceof Error?e.message:'Не удалось сохранить собственника')}
    finally{setBusy(false)}
  }
  return <div className="form-section">
    <label className="field horizontal-field">Собственник КТК<StockOwnerSelect type={type ?? undefined} value={owner} onChange={setOwner}/></label>
    <button className="secondary-button" type="button" disabled={busy || !owner || owner===ownerId} onClick={save}>Сохранить группу</button>
    {error && <span role="alert">{error}</span>}
  </div>
}
