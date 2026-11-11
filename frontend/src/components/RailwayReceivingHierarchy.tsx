import type { OrderDetails, ReceivingContainerAttributes, ReferenceOption } from '../domain'
import { OrderContainerTable, type ContainerTableGroup } from './OrderContainerTable'
import './RailwayReceivingHierarchy.css'

export function RailwayReceivingHierarchy({waybills,containers,defaultOwnerId,onChange,onBulkOwnerChange,bulkOwnerDisabled,bulkOwnerActionTarget}:{
  onBulkOwnerChange?:(ids:string[],owner:ReferenceOption)=>void|Promise<void>
  bulkOwnerDisabled?:boolean
  bulkOwnerActionTarget?:HTMLElement|null
  waybills:OrderDetails['waybills']
  containers:OrderDetails['containers']
  defaultOwnerId?:string
  onChange?:(id:string,change:ReceivingContainerAttributes)=>void
}) {
  if(!waybills.length)return <div className="inline-empty">Накладные не найдены</div>
  const groups:ContainerTableGroup[]=waybills.map(bill=>({key:bill.id,label:'Накладная № '+bill.number,rows:[],children:bill.railwayCarriages.map(wagon=>({
    key:bill.id+'-'+wagon.id,label:'Вагон № '+wagon.number,
    rows:wagon.containers.map(source=>{
      const row=containers.find(item=>item.containerId===source.containerId)
      return {...row,key:source.containerId,containerId:source.containerId,name:source.number,
        empty:source.netWeight===0,readOnly:!row,
        sealNumbers:source.sealNumbers,sealTypeName:source.sealTypeName,
        hazardClassName:[...new Set(bill.products.map(p=>p.hazardClassName).filter(Boolean))].join(', ') || null,
        containerType:source.type,loadCapacity:source.loadCapacity,tareWeight:source.tareWeight,grossWeight:source.grossWeight}
    })
  }))}))
  return <section className="form-section composition-section" aria-label="КТК по накладным и вагонам"><OrderContainerTable rows={groups.flatMap(group=>group.children?.flatMap(wagon=>wagon.rows)??group.rows)} groups={groups} onBulkOwnerChange={onBulkOwnerChange} bulkOwnerDisabled={bulkOwnerDisabled} bulkOwnerActionTarget={bulkOwnerActionTarget} attributesReadOnly showPhysicalAttributes columnWidths={[44,136,128,80,88,140,144,84,76,80,112,108]} defaultOwnerId={defaultOwnerId} onChange={onChange}/></section>
}
