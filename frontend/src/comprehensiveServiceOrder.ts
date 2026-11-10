import type { CreatedOrder, OrderDetails, ReturnReceivingOrder } from './domain'

export type ContractOption = { id: string; clientId: string; name: string; contractType?: string; validFrom?: string | null }
export type ComprehensiveServiceOrderSummary = {
  id: string; code: number; clientId: string; clientName: string
  contractId: string; contractName: string; status: string; shippingOrderCount: number; createdAt: string | null; workflow: 'RAILWAY_RETURN' | 'AUTO_RETURN'; sourceServiceOrderId: string | null
}
export type ComprehensiveServiceOrderDetails = {
  transportOrders: ServiceTransportOrder[]
  totalWithoutVat: number; totalWithVat: number
  progress: ServiceProgress
  order: ComprehensiveServiceOrderSummary; receivingOrder: OrderDetails; shippingOrders: Array<CreatedOrder & { containerNames: string[]; plannedAt?: string | null; consignee?: string | null }>; selectableContainers: Array<{ containerId: string; containerName: string; type: string }>; returnOrders: ReturnReceivingOrder[]
}

export type ServiceProgress = {
  serviceName: string
  accepted: number; shippingCreated: number; shippingCompleted: number
  returnCreated: number; returnCompleted: number
  total: number; shippingMissing: number
  shippingOrderCount: number; shippingOrdersCompleted: number
  returnOrderCount: number; returnOrdersCompleted: number; returnMissing: number
}

export type ServiceTransportMetadataChange = {
 id:string; kind:'SHIPPING'|'RETURN_RECEIVING'|'INITIAL_RECEIVING'; plannedAt:string|null; partyName:string|null;
 originalPlannedAt:string|null; originalPartyName:string|null
}

export type ServiceTransportOrder = {
  id: string; kind: import('./routes').RouteType; status: string
  terminalAreaId: string; transportType: import('./domain').TransportType
  route?: { id: string; code: number } | null
}
