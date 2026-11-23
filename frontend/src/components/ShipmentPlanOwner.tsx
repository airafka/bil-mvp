import { useState } from 'react'
import { request } from '../http'
import { StockOwnerSelect } from './StockOwnerSelect'
import { UiSelect } from './FormControls'
import type { ReferenceOption } from '../domain'

export function ShipmentPlanOwner({orderId,rowId,wagon=false,ownerId,type,types,onSaved}:{
  orderId:string; rowId:string; wagon?:boolean; ownerId?:string|null; type?:string|null; types?:ReferenceOption[]; onSaved:()=>Promise<void>
}) {
  const [owner,setOwner]=useState(ownerId ?? '')
  const [selectedType,setType]=useState(type ?? '')
  const [busy,setBusy]=useState(false)
  const [error,setError]=useState('')
  async function save() {
    setBusy(true);setError('')
    try {
      await request('/api/shipping-orders/'+orderId+'/plan/'+(wagon?'wagons':'containers')+'/'+rowId+'/owner',{
        method:'PUT',body:JSON.stringify({ownerId:owner,typeId:wagon?selectedType:null})})
      await onSaved()
    } catch(e){setError(e instanceof Error?e.message:'Не удалось сохранить собственника')}
    finally{setBusy(false)}
  }
  return <div className="form-section">
    {wagon && <label className="field horizontal-field">Тип вагона<UiSelect value={selectedType} disabled={busy} onChange={e=>setType(e.target.value)}>
      <option value="">Выберите тип</option>{types?.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</UiSelect></label>}
    <label className="field horizontal-field">{wagon?'Собственник вагона':'Собственник КТК'}<StockOwnerSelect wagon={wagon} type={selectedType} value={owner} onChange={setOwner}/></label>
    <button className="secondary-button" type="button" disabled={busy || !owner || (wagon && !selectedType) || (owner===ownerId && selectedType===(type??''))} onClick={save}>Сохранить группу</button>
    {error && <span role="alert">{error}</span>}
  </div>
}
