export const containerStatusLabels: Record<string, string> = {
  EXPECTED: 'Ожидает поставки', ON_TERMINAL: 'В остатках', RESERVED_OUT: 'Ожидает вывоза', DEPARTED: 'Нет в остатках',
}
export const containerStatusLabel = (value: string | null) => value ? containerStatusLabels[value] ?? value : '—'
export type StockOwner = { id: string; containerId: string; containerName: string; containerType: string; clientId?: string | null; clientName?: string | null; status: string; receivingOrderId: string | null; shippingOrderId: string | null }
export type OwnerHistory = { id: string; containerId: string; oldClientName: string | null; newClientName: string | null; oldStatus: string | null; newStatus: string | null; orderId: string; orderType: string; orderNumber: number | null; createdAt: string; cancellation: boolean; operationType?: string; occurredAt?: string; containerPeriodId?: string; previousContainerPeriodId?: string }
export type OwnershipHeader = { id: string; number: number; clientId: string; clientName: string; sourceClientId: string | null; sourceClientName: string | null; service: 'CHANGE_OWNER'; comment: string | null; status: 'DRAFT' | 'SCHEDULED' | 'DONE'; executionError?: string; exportQueued: boolean; exportSentAt?: string; exportError?: string; effectiveDate?: string | null; completionAt: string | null; containerQuantity: number }
export type OwnershipContainer = { containerVisitId?: string | null; expectedClientId?: string | null; resultStatus?: string | null; resultReason?: string | null; id: string | null; containerOwnerId: string; containerId: string; containerName: string; containerType: string; clientId: string; clientName: string; status: string }
export type OwnershipDetails = { order: OwnershipHeader; containers: OwnershipContainer[] }
export function historyOrderPath(row: Pick<OwnerHistory, 'orderId' | 'orderType'>) {
  return (row.orderType === 'RECEIVING_ORDER' ? '/receiving-orders/' : row.orderType === 'SHIPPING_ORDER' ? '/shipping-orders/' : '/service-orders/') + row.orderId
}

export type ContainerStockLookup = { containerId: string; ownerClientId?: string | null; ownerClientName?: string | null; status?: string | null }
