export type StoragePeriod = {
  id: string; containerId: string; containerName: string; terminalAreaName: string;
  receivingOrderId: string; receivingOrderNumber: number; arrivalAt: string; clientName?: string; ownerName?: string;
  arrivalTransport?: string; arrivalCarrier?: string; consignor?: string; cargoName?: string; empty?: boolean;
  shippingOrderId?: string; shippingOrderNumber?: number; departureAt?: string; departureTransport?: string;
  departureCarrier?: string; consignee?: string; shippingClientName?: string; shippingOwnerName?: string; storageDays?: number; inStock?: boolean; status: string;
  arrivalTimeSource?: string; departureTimeSource?: string;
}
export type StorageIssue = { id: string; containerId: string; containerName: string; reason: string }
export const storageDate = (value?: string) => value ? new Date(value).toLocaleString('ru-RU', {
  timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
}) : '—'
export const storageStatus = (status: string) => ({ OPEN: 'На терминале', CLOSED: 'Вывезен', CANCELLED: 'Аннулирован' }[status] ?? status)
export const transportLabel = (value?: string) => value === 'VEHICLE' ? 'Авто' : value === 'RAILWAY' ? 'ЖД' : value || '—'
export const timeSourceLabel = (value?: string) => ({ MOVEMENT: 'Дата складского события', HISTORY_CREATED: 'Дата записи старой истории', MANUAL_COMPLETION: 'Время ручного выполнения операции' }[value ?? ''] ?? 'Источник времени не указан')
export const operationLabel = (value?: string) => ({
  ARRIVAL: 'Приём', DEPARTURE: 'Вывоз', RESERVE_RECEIVING: 'Ожидание поставки', RESERVE_SHIPPING: 'Резерв под вывоз',
  OWNER_CHANGE: 'Смена собственника', CANCEL_ARRIVAL: 'Аннулирование приёма', CANCEL_DEPARTURE: 'Аннулирование вывоза',
  CANCEL_RECEIVING_RESERVATION: 'Отмена ожидаемой поставки', CANCEL_SHIPPING_RESERVATION: 'Снятие резерва вывоза',
  LEGACY: 'Старая запись',
}[value ?? ''] ?? 'Изменение состояния')

// MVP reference labels and historical snapshots contain "011005 — Пшеница".
export const storageCargoName = (value?: string) => value?.split(';')
  .map(item => item.trim().replace(/^\d{6}(?=\s|[—–-]|$)\s*(?:[—–-]\s*)?/, '').trim())
  .filter(item => item && !/^\d+$/.test(item)).join('; ') || '—'
