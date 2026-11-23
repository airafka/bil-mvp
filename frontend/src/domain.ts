export type OrderKind = 'receiving' | 'shipping'

export type ReferenceOption = {
  id: string
  name: string
  type?: ContainerType | null
  loadCapacity?: number | null
  tareWeight?: number
}

export type TransportType = 'VEHICLE' | 'RAILWAY'
export type FillingType = 'ALL' | 'NONE_CONTAINER'
export type ContainerType =
  | 'STANDARD_20'
  | 'STANDARD_40'

export const fillingTypeOptions: Array<{ value: FillingType; name: string }> = [
  { value: 'ALL', name: 'Заданы номера вагонов и КТК' },
  { value: 'NONE_CONTAINER', name: 'Безномерный вывоз по авто' },
]

export const fillingTypeLabel = (value: FillingType | null | undefined) =>
  fillingTypeOptions.find((option) => option.value === (value ?? 'ALL'))?.name ?? 'Заданы номера вагонов и КТК'

export const containerTypeOptions: Array<{ value: ContainerType; name: string }> = [
  { value: 'STANDARD_20', name: 'Стандартный 20' },
  { value: 'STANDARD_40', name: 'Стандартный 40' },
]

export const containerTypeLabel = (value: ContainerType) =>
  containerTypeOptions.find((option) => option.value === value)?.name ?? value

export type TerminalAreaOption = {
  id: string
  code: string
  name: string
}

export type TransportTypeOption = {
  value: TransportType
  name: string
}

export type CreatedWaybill = {
  id: string
  number: string
}

type WaybillProductFields = {
  dangerProductId?: string | null
  dangerProductIdentifier?: number | null
  dangerProductName?: string | null
  dangerClassCode?: string | null
  signDanger?: string | null
  grossWeight?: number | null
  hazardClassId?: string | null
  hazardClassName?: string | null
  id: string
  etsngCodeId: string
  weight: number | null
}

export type WaybillProductSummary = WaybillProductFields & {
  code: string
  name: string
}

export type WaybillContainerSummary = Omit<ReceivingContainerAttributes, 'hazardClassId' | 'hazardClassName'> & {
  owner?: string | null
  type?: ContainerType | null; loadCapacity?: number | null
  containerId: string; number: string; grossWeight: number; tareWeight: number; netWeight: number
  etsngCodeId?: string | null; etsngCodeName?: string | null
}

export type WaybillLink = {
  createdAt?: string | null
  shipmentType?: string
  status?: string
  containers?: WaybillContainerSummary[]
  railwayCarriages?: WaybillCarriageSummary[]
  id: string
  number: string
  railwayCarriageCount: number
  containerCount: number
  products: WaybillProductSummary[]
}

export type WaybillCarriageSummary = {
  typeName?: string | null
  modelName?: string | null
  loadCapacity?: number | null
  nextDepotRepairDate?: string | null
  id: string
  number: string
  containers: WaybillContainerSummary[]
}

export type GroupedWaybill = {
  groupKey: string
  departureStation: number
  destinationStation: number
  payer: string
  products: WaybillProductSummary[]
  railwayCarriageCount: number
  containerCount: number
  waybillCount: number
  waybills: WaybillLink[]
}

export type GroupedWaybillPage = {
  content: GroupedWaybill[]
  totalElements: number
  totalPages: number
  number: number
  size: number
}

export type GroupedWaybillFilter = {
  departureStation?: number
  destinationStation?: number
  payer?: string
}

type OrderHeaderFields = {
  routeId?: string | null
  comment?: string | null
  contractId: string | null
  contractName: string | null
  comprehensiveServiceOrderId: string | null
  sourceReceivingOrderId?: string | null
  id: string
  code: number
  clientId: string
  clientName: string
  terminalArea: TerminalAreaOption
  transportType: TransportType | null
  fillingType: FillingType
  status: string
}

export type OrderSummary = OrderHeaderFields & {
  plannedAt?: string | null
  routeNumber?: number | null
  comprehensiveServiceOrderNumber?: number | null
}

export type PagedResponse<T> = {
  items: T[]
  page: number
  size: number
  totalElements: number
  totalPages: number
}

export type CreatedOrder = {
  id: string
  code: number
  status: string
}

export type OrderCargoDetails = {
  etsngCodeId: string
  etsngCodeName: string
  weight: number
}

export type ReceivingContainerAttributes = {
  ownerClientId?: string | null
  ownerClientName?: string | null
  sealNumbers?: string | null
  sealTypeId?: string | null
  sealTypeName?: string | null
  hazardClassId?: string | null
  hazardClassName?: string | null
}

export type OrderContainerDetails = ReceivingContainerAttributes & {
  taskId?: string
  containerType?: ContainerType
  containerStatus?: string | null
  containerId: string
  containerName: string
  empty: boolean
  cargo: OrderCargoDetails | null
  cargoItems?: OrderCargoDetails[]
}

export type OrderWaybillContainerDetails = WaybillContainerSummary

export type OrderWaybillCarriageDetails = {
  typeName?: string | null
  modelName?: string | null
  loadCapacity?: number | null
  nextDepotRepairDate?: string | null
  id: string
  railwayCarriageId: string
  number: string
  containers: OrderWaybillContainerDetails[]
}

export type OrderWaybillProductDetails = WaybillProductFields & {
  etsngCode: string
}

export type OrderWaybillDetails = {
  id: string
  number: string
  departureStation: number
  destinationStation: number
  payer: string
  railwayCarriages: OrderWaybillCarriageDetails[]
  products: OrderWaybillProductDetails[]
}

export type ShippingOrderRailwayCarriageDetails = {
  railwayCarriageId: string
  railwayCarriageCode: string
  ownerName?: string | null
  containers: OrderContainerDetails[]
}

export type ContainerQuantityDetails = {
  ownerClientId?: string | null
  ownerName?: string | null
  id: string
  quantity: number
  type: ContainerType
  empty: boolean
}

export type OrderDetails = OrderHeaderFields & {
  createdAt?: string | null
  transportWaybillNumber?: string | null
  authorizedRepresentative?: string | null
  phone?: string | null
  email?: string | null
  contractType?: string | null
  defaultContainerOwnerId?: string | null
  defaultContainerOwnerName?: string | null
  arrivalAt: string | null
  consignor: string | null
  departureAt: string | null
  consignee: string | null
  sourceShippingOrderId?: string | null
  returnOrders?: ReturnReceivingOrder[]
  containers: OrderContainerDetails[]
  waybills: OrderWaybillDetails[]
  railwayCarriages: ShippingOrderRailwayCarriageDetails[]
  containerQuantities: ContainerQuantityDetails[]
}

export type OrderConfig = {
  kind: OrderKind
  title: string
  createTitle: string
  description: string
  listPath: string
  createPath: string
  apiPath: string
  successText: string
}

export const orderConfigs: Record<OrderKind, OrderConfig> = {
  receiving: {
    kind: 'receiving',
    title: 'Заявки на поставку',
    createTitle: 'Новая заявка на поставку',
    description: 'Приём КТК клиента на терминал',
    listPath: '/receiving-orders',
    createPath: '/receiving-orders/new',
    apiPath: '/api/receiving-orders',
    successText: 'Заявка на поставку создана',
  },
  shipping: {
    kind: 'shipping',
    title: 'Заявки на вывоз',
    createTitle: 'Новая заявка на вывоз',
    description: 'Выдача КТК клиента с терминала',
    listPath: '/shipping-orders',
    createPath: '/shipping-orders/new',
    apiPath: '/api/shipping-orders',
    successText: 'Заявка на вывоз создана',
  },
}

export function statusLabel(status: string) {
  return ({ DRAFT: 'Черновик', CANCELLED: 'Отменено', PAID: 'Оплачен', CONFIRMED: 'Подтверждено', COMPLETED: 'Выполнено' } as Record<string, string>)[status] ?? status
}

export function transportTypeLabel(transportType: TransportType | null) {
  if (transportType === 'VEHICLE') return 'Авто'
  if (transportType === 'RAILWAY') return 'ЖД'
  return '—'
}

export type DangerProductOption = { id: string; identifier: number; name: string; dangerClassId: string; dangerClassName: string; dangerClassCode: string | null }

export type ReturnReceivingOrder = {
  id: string; code: number; status: string; containerNames: string[]; containerIds: string[]
  plannedAt?: string | null; consignor?: string | null
  comprehensiveServiceOrderId: string; comprehensiveServiceOrderCode: number
  clientName: string; contractName: string
}
