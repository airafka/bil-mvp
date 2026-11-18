export type StoragePeriod = {
  id: string; containerId: string; containerName: string;
  arrivalAt: string; ownerName?: string; departureAt?: string; status: string; storageDays: number;
  startOrderId?: string; startOrderType?: string; startOrderNumber?: number;
  endOrderId?: string; endOrderType?: string; endOrderNumber?: number;
}
export const storageDate = (value?: string) => value ? new Date(value).toLocaleString('ru-RU', {
  timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
}) : '—'
export const storageStatus = (status: string) => ({ OPEN: 'Открыт', CLOSED: 'Закрыт', CANCELLED: 'Аннулирован' }[status] ?? status)
export const storageBoundaryLabel = (value?: string) => ({ RECEIVING_ORDER: 'Поставка', SHIPPING_ORDER: 'Вывоз', SERVICE_ORDER: 'Смена собственника' }[value ?? ''] ?? '')
export const operationLabel = (value?: string) => ({
  ARRIVAL: 'Приём', DEPARTURE: 'Вывоз', RESERVE_RECEIVING: 'Ожидание поставки', RESERVE_SHIPPING: 'Резерв под вывоз',
  OWNER_CHANGE: 'Смена собственника', CANCEL_ARRIVAL: 'Аннулирование приёма', CANCEL_DEPARTURE: 'Аннулирование вывоза',
  CANCEL_RECEIVING_RESERVATION: 'Отмена ожидаемой поставки', CANCEL_SHIPPING_RESERVATION: 'Снятие резерва вывоза',
  LEGACY: 'Старая запись',
}[value ?? ''] ?? 'Изменение состояния')
