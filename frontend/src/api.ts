import { request } from './http'
export { ApiError } from './http'
import type {
  ContractOption,
  CreatedOrder,
  CreatedWaybill,
  GroupedWaybillFilter,
  GroupedWaybillPage,
  OrderDetails,
  OrderSummary,
  PagedResponse,
  ReferenceOption,
  TerminalAreaOption,
  TransportTypeOption,
} from './domain'
import type { CreateOrderPayload } from './orderForm'
import type { RouteType, RouteSummary, RouteOrder, RouteDetails, CreateRoutePayload } from './routes'
import type { CreateWaybillPayload } from './waybillForm'
export function getReferenceOptions(resource: 'clients' | 'containers' | 'etsng-codes' | 'railway-carriages' | 'seal-types' | 'hazard-classes' | 'danger-products' | 'railway-carriage-models' | 'railway-carriage-kinds', query = '') {
  return request<ReferenceOption[]>(`/api/references/${resource}?limit=100&q=${encodeURIComponent(query)}`)
}

export function getTerminalAreas() {
  return request<TerminalAreaOption[]>('/api/references/terminal-areas')
}

export function getTransportTypes() {
  return request<TransportTypeOption[]>('/api/references/transport-types')
}

export function getOrders(apiPath: string, page: number, size = 20, query = '', status = '') {
  return request<PagedResponse<OrderSummary>>(`${apiPath}?page=${page}&size=${size}&query=${encodeURIComponent(query)}&status=${encodeURIComponent(status)}`)
}

export function updateOrderContainerAttributes(apiPath: string, id: string, containers: Array<import('./domain').ReceivingContainerAttributes & { containerId: string }>, defaultContainerOwnerId?: string, additions: Array<{container: CreateOrderPayload['containers'][number]; railwayCarriageId?: string}> = [], metadata?: { plannedAt: string | null; consignor: string | null; consignee: string | null }) {
  return request<OrderDetails>(`${apiPath}/${id}/containers`, { method: 'PATCH', body: JSON.stringify({ containers, ...(metadata ? { metadata } : {}), ...(defaultContainerOwnerId ? { defaultContainerOwnerId } : {}), ...(additions.length ? { additions } : {}) }) })
}

export function getOrder(apiPath: string, id: string) {
  return request<OrderDetails>(`${apiPath}/${id}`)
}

export function createOrder(apiPath: string, payload: CreateOrderPayload) {
  return request<CreatedOrder>(apiPath, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function createWaybill(payload: CreateWaybillPayload) {
  return request<CreatedWaybill>('/api/waybills', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function getGroupedWaybills(
  filter: GroupedWaybillFilter,
  page: number,
  size = 20,
  availableForReceivingOrderOnly = false,
) {
  return request<GroupedWaybillPage>('/api/waybills/grouped/page', {
    method: 'POST',
    body: JSON.stringify({
      filter,
      pageInfo: { page, size },
      sortingColumn: 'departureStation',
      sortingDirection: 'ASC',
      availableForReceivingOrderOnly,
    }),
  })
}


export function getContracts() { return request<ContractOption[]>('/api/references/contracts') }
export function changeOrderStatus(apiPath: string, id: string, expectedStatus: string, status: string) {
  return request<CreatedOrder>(`${apiPath}/${id}/status`, { method: 'PATCH', body: JSON.stringify({ expectedStatus, status }) })
}

export function getRoutes() { return request<RouteSummary[]>('/api/routes') }
export function confirmRoute(id: string) { return request<RouteDetails>('/api/routes/' + id + '/confirm', { method: 'POST' }) }
export function getRoute(id: string) { return request<RouteDetails>('/api/routes/' + id) }
export function getAvailableRouteOrders(routeType: RouteType, transportType: string, terminalAreaId: string) {
  return request<RouteOrder[]>(`/api/routes/available-orders?routeType=${routeType}&transportType=${transportType}&terminalAreaId=${terminalAreaId}`)
}
export function createRoute(payload: CreateRoutePayload) {
  return request<RouteDetails>('/api/routes', { method: 'POST', body: JSON.stringify(payload) })
}

export function assignRouteOrders(id: string, orderIds: string[]) {
  return request<RouteDetails>('/api/routes/' + id + '/orders', { method: 'POST', body: JSON.stringify({ orderIds }) })
}

export function getRailwayCarriagePage(page: number) {
  return request<PagedResponse<import('./railwayCarriages').RailwayCarriage>>(`/api/references/railway-carriages/page?page=${page}&size=20`)
}
export function updateRailwayCarriage(id: string, value: import('./railwayCarriages').RailwayCarriagePatch) {
  return request<import('./railwayCarriages').RailwayCarriage>(`/api/references/railway-carriages/${id}`, { method: 'PATCH', body: JSON.stringify(value) })
}

export function updateContainerAttributes(id: string, tareWeight: string, loadCapacity: string | null) {
  return request<ReferenceOption>('/api/references/containers/' + id + '/attributes', { method: 'PATCH', body: JSON.stringify({ tareWeight, loadCapacity }) })
}

export function finishContainerOrder(apiPath: string, id: string) {
  return request<import('./domain').CreatedOrder>(apiPath + '/' + id + '/events', { method: 'POST', body: JSON.stringify({ eventCode: apiPath === '/api/receiving-orders' ? 'UNLOAD_FINISH' : 'LOAD_FINISH' }) })
}

export function getContainerStock(query = '', clientId = '', status = '', page = 0) {
  return request<PagedResponse<import('./containerStock').StockOwner>>('/api/container-owners?' + new URLSearchParams({ query, ...(clientId ? { clientId } : {}), ...(status ? { status } : {}), page: String(page) }))
}
export function getOwnerHistory(id: string, includeReservations = false) { return request<import('./containerStock').OwnerHistory[]>('/api/containers/' + id + '/owner-history?includeReservations=' + includeReservations) }
export function getOwnershipOrders(query = '', page = 0) { return request<PagedResponse<import('./containerStock').OwnershipHeader>>('/api/service-orders?' + new URLSearchParams({ query, page: String(page) })) }
export function getOwnershipOrder(id: string) { return request<import('./containerStock').OwnershipDetails>('/api/service-orders/' + id) }
export function createOwnershipOrder(clientId: string, comment: string, containerOwnerIds: string[], effectiveDate: string, sourceClientId?: string) { return request<import('./containerStock').OwnershipDetails>('/api/service-orders', { method: 'POST', body: JSON.stringify({ clientId, sourceClientId, service: 'CHANGE_OWNER', comment, containerOwnerIds, effectiveDate }) }) }
export function updateOwnershipOrder(id: string, comment: string, effectiveDate: string, changes?: { clientId: string; containerOwnerIds: string[] }) { return request<import('./containerStock').OwnershipDetails>('/api/service-orders/' + id, { method: 'PUT', body: JSON.stringify({ id, service: 'CHANGE_OWNER', comment, effectiveDate, ...changes }) }) }
export function getOwnershipAvailable(id: string, query = '', page = 0, effectiveDate = '', clientId = '') { return request<PagedResponse<import('./containerStock').OwnershipContainer>>('/api/service-orders/' + id + '/containers/available?' + new URLSearchParams({ ...(effectiveDate ? { effectiveDate } : {}), ...(clientId ? { clientId } : {}), query, page: String(page) })) }
export function saveOwnershipSelection(id: string, containerOwnerIds: string[]) { return request<import('./containerStock').OwnershipDetails>('/api/service-orders/' + id + '/containers', { method: 'PUT', body: JSON.stringify(containerOwnerIds.map(containerOwnerId => ({ containerOwnerId }))) }) }
export function acceptOwnershipOrder(id: string) { return request<import('./containerStock').OwnershipDetails>('/api/service-orders/' + id + '/accept', { method: 'POST' }) }
export function withdrawOwnershipOrder(id: string) { return request<import('./containerStock').OwnershipDetails>('/api/service-orders/' + id + '/withdraw', { method: 'POST' }) }
export function deleteOwnershipOrder(id: string) { return request<void>('/api/service-orders/' + id, { method: 'DELETE' }) }

export async function lookupContainerStock(containerIds: string[]) {
  const ids = [...new Set(containerIds)]
  const byId = new Map<string, import('./containerStock').ContainerStockLookup>()
  for (let offset = 0; offset < ids.length; offset += 1000) {
    const rows = await request<import('./containerStock').ContainerStockLookup[]>('/api/container-owners/lookup', {
      method: 'POST', body: JSON.stringify({ containerIds: ids.slice(offset, offset + 1000) }),
    })
    for (const row of rows) byId.set(row.containerId, row)
  }
  return ids.flatMap(id => { const row = byId.get(id); return row ? [row] : [] })
}

export type AvailableWaybillRow = Pick<import('./domain').GroupedWaybill, 'groupKey' | 'departureStation' | 'destinationStation' | 'payer'> & { waybill: import('./domain').WaybillLink }
export type AvailableWaybillPage = { content: AvailableWaybillRow[]; totalElements: number; totalPages: number; number: number; size: number }
export function getAvailableWaybills(page: number, filter: GroupedWaybillFilter = {}) {
  const params = new URLSearchParams({ page: String(page), size: '20' })
  if (filter.departureStation !== undefined) params.set('departureStation', String(filter.departureStation))
  if (filter.destinationStation !== undefined) params.set('destinationStation', String(filter.destinationStation))
  if (filter.payer) params.set('payer', filter.payer)
  return request<AvailableWaybillPage>('/api/waybills/available?' + params)
}
export function getWaybillSelectionOptions() {
  return request<import('./waybillSelection').WaybillSelectionOption[]>('/api/waybills/available/options')
}

export function getOwnershipAvailableForCreate(clientId: string, query = '', page = 0, effectiveDate = '', sourceClientId = '') { return request<PagedResponse<import('./containerStock').OwnershipContainer>>('/api/service-orders/containers/available?' + new URLSearchParams({ ...(effectiveDate ? { effectiveDate } : {}), ...(sourceClientId ? { sourceClientId } : {}), clientId, query, page: String(page) })) }

export function getTransportCatalog(kind: import('./transportCatalogs').TransportCatalogKind) {
 return request<import('./transportCatalogs').TransportCatalogEntry[]>('/api/transport-catalogs/'+kind)
}
export function getTransportCatalogEntry(kind: import('./transportCatalogs').TransportCatalogKind,id:string) {
 return request<import('./transportCatalogs').TransportCatalogEntry>('/api/transport-catalogs/'+kind+'/'+id)
}
export function saveTransportCatalogEntry(kind: import('./transportCatalogs').TransportCatalogKind,id:string|null,payload:import('./transportCatalogs').TransportCatalogInput) {
 return request<import('./transportCatalogs').TransportCatalogEntry>('/api/transport-catalogs/'+kind+(id?'/'+id:''),{method:id?'PUT':'POST',body:JSON.stringify(payload)})
}
export function deleteTransportCatalogEntry(kind: import('./transportCatalogs').TransportCatalogKind,id:string) {
 return request<void>('/api/transport-catalogs/'+kind+'/'+id,{method:'DELETE'})
}
export function updateRoute(id:string,payload:Pick<CreateRoutePayload,'departureAt'|'carrierId'|'driverId'|'vehicleId'|'comment'|'orderIds'>) {
 return request<RouteDetails>('/api/routes/'+id,{method:'PUT',body:JSON.stringify(payload)})
}

export function generateWaybill(standard20: number, standard40: number) { return request<CreatedWaybill>('/api/waybills/generate', { method: 'POST', body: JSON.stringify({ standard20, standard40 }) }) }

export function cancelOrder(apiPath: string, id: string, expectedStatus: string) {
  return request<CreatedOrder>(apiPath + '/' + id + '/cancellation', { method: 'POST', body: JSON.stringify({ expectedStatus }) })
}
