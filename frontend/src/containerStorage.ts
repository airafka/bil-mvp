export type StoragePeriod = {
  id: string; containerId: string; containerName: string;
  arrivalAt: string; ownerName?: string; departureAt?: string; status: string; storageDays: number; storageDaysInPeriod?: number;
  startOrderId?: string; startOrderType?: string; startOrderNumber?: number;
  endOrderId?: string; endOrderType?: string; endOrderNumber?: number;
  receivingClientName?: string; receivingOwnerName?: string; arrivalTransport?: string; arrivalParty?: string; arrivalCargo?: string;
  shippingClientName?: string; shippingOwnerName?: string; departureTransport?: string; departureParty?: string; departureCargo?: string;
}
export type StorageVisit = {
  id: string; containerId: string; containerName: string; receivingAt: string; shippingAt?: string;
  receivingOrderId: string; receivingOrderNumber: number; shippingOrderId?: string; shippingOrderNumber?: number;
  storageDays: number; storageDaysInPeriod?: number; periods: StoragePeriod[];
}
export const storageDate = (value?: string) => value ? new Date(value).toLocaleString('ru-RU', {
  timeZone: 'UTC', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
}) : '—'
export const storageClientOwner = (client?: string, owner?: string) => !client && !owner ? '' : (client || '—') + ' / ' + (owner || '—')
export const storageTransport = (value?: string) => ({ VEHICLE: 'Авто', RAILWAY: 'ЖД' }[value ?? ''] ?? '')
export const storageBoundaryLabel = (value?: string) => ({ RECEIVING_ORDER: 'Поставка', SHIPPING_ORDER: 'Вывоз', SERVICE_ORDER: 'Смена собственника' }[value ?? ''] ?? '')
export const operationLabel = (value?: string) => ({
  ARRIVAL: 'Приём', DEPARTURE: 'Вывоз', RESERVE_RECEIVING: 'Ожидание поставки', RESERVE_SHIPPING: 'Резерв под вывоз',
  OWNER_CHANGE: 'Смена собственника', CANCEL_ARRIVAL: 'Аннулирование приёма', CANCEL_DEPARTURE: 'Аннулирование вывоза',
  CANCEL_RECEIVING_RESERVATION: 'Отмена ожидаемой поставки', CANCEL_SHIPPING_RESERVATION: 'Снятие резерва вывоза',
  LEGACY: 'Старая запись',
}[value ?? ''] ?? 'Изменение состояния')
