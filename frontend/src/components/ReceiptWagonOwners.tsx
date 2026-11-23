import { useEffect, useState } from 'react'
import { request } from '../http'
import { getReferenceOptions } from '../api'
import type { ReferenceOption } from '../domain'
import { UiSelect } from './FormControls'

type Wagon = { id: string; code: string; ownerId: string | null; ownerName: string | null }
export function ReceiptWagonOwners({ orderId, draft }: { orderId: string; draft: boolean }) {
  const path='/api/receiving-orders/'+orderId
  const [wagons,setWagons]=useState<Wagon[]>([])
  const [clients,setClients]=useState<ReferenceOption[]>([])
  const [error,setError]=useState('')
  const [busy,setBusy]=useState(false)
  useEffect(()=>{
    let active=true
    Promise.all([request<Wagon[]>(path+'/wagon-owners'),draft?getReferenceOptions('clients'):Promise.resolve([])])
      .then(([rows,options])=>{if(active){setWagons(rows);setClients(options)}})
      .catch(e=>{if(active)setError(e.message)})
    return ()=>{active=false}
  },[path,draft])
  async function change(id:string,ownerId:string) {
    setBusy(true);setError('')
    try {setWagons(await request<Wagon[]>(path+'/wagons/'+id+'/owner',{method:'PUT',body:JSON.stringify({ownerId})}))}
    catch(e){setError(e instanceof Error?e.message:'Не удалось сохранить собственника вагона')}
    finally{setBusy(false)}
  }
  return <section className="form-section"><h3>Собственники вагонов</h3>{wagons.map(w=><label className="field horizontal-field" key={w.id}>
    <span>Вагон {w.code}</span>{draft?<UiSelect disabled={busy} value={w.ownerId ?? ''} onChange={e=>void change(w.id,e.target.value)}>
      {w.ownerId && !clients.some(c=>c.id===w.ownerId) && <option value={w.ownerId}>{w.ownerName}</option>}
      {clients.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</UiSelect>:<span>{w.ownerName ?? 'Не указан'}</span>}
  </label>)}{error && <p role="alert">{error}</p>}</section>
}
