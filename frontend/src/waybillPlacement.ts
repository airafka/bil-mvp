import { request } from './http'
import type { PagedResponse } from './domain'
export type PlacementCandidate = { id: string; number: string; receivingNumber: number | null; wagonNumbers: string; containerCount: number; departure: string; destination: string }
export type PlacementWagon = { id: string; number: string; feet: number | null; capacity: number | null }
export type PlacementContainer = { rowId: string; containerId: string; number: string; type: string; grossWeight: number; waybillId: string; waybillNumber: string; wagonId: string; selected: boolean }
export type PlacementLayout = { waybills: { id: string; number: string }[]; wagons: PlacementWagon[]; containers: PlacementContainer[]; version: string }
export type PlacementMap = Record<string, string>
export const placementCandidates = (query: string, page: number) => request<PagedResponse<PlacementCandidate>>('/api/waybills/placement/candidates?query='+encodeURIComponent(query)+'&page='+page)
export const placementWagons = (query: string) => request<PlacementWagon[]>('/api/waybills/placement/wagons?query='+encodeURIComponent(query))
export const placementPreview = (waybillIds: string[], layout?: PlacementLayout, addWagonId?: string) => request<PlacementLayout>('/api/waybills/placement/preview', { method: 'POST', body: JSON.stringify({ waybillIds, ...(layout ? { wagonIds: layout.wagons.map(w => w.id), expectedVersion: layout.version, addWagonId } : {}) }) })
export const savePlacement = (layout: PlacementLayout, positions: PlacementMap) => request<PlacementLayout>('/api/waybills/placement', { method: 'PUT', body: JSON.stringify({ waybillIds: layout.waybills.map(w => w.id), wagonIds: layout.wagons.map(w => w.id), version: layout.version, assignments: layout.containers.filter(c => c.selected).map(c => ({ rowId: c.rowId, wagonId: positions[c.rowId] ?? c.wagonId })) }) })
export function wagonIssue(wagon: PlacementWagon, rows: PlacementContainer[]): string | null {
  if (!rows.length) return null
  if (rows.length > 2) return 'На вагоне может быть не более двух КТК'
  if (wagon.feet == null || wagon.capacity == null) return 'В справочнике не указана длина или грузоподъёмность'
  if (rows.reduce((n, c) => n + (c.type === 'STANDARD_20' ? 20 : c.type === 'STANDARD_40' ? 40 : 10000), 0) > wagon.feet) return 'Недостаточно длины платформы'
  if (rows.reduce((n, c) => n + c.grossWeight, 0) > wagon.capacity + 0.000001) return 'Превышена грузоподъёмность'
  return null
}
export function transfer(positions: PlacementMap, rows: PlacementContainer[], rowId: string, wagonId: string, swapId?: string): PlacementMap {
  const source = rows.find(c => c.rowId === rowId)
  const target = swapId ? rows.find(c => c.rowId === swapId) : null
  if (!source?.selected || (swapId && !target?.selected)) return positions
  const next = { ...positions, [rowId]: wagonId }
  if (target && target.rowId !== source.rowId) next[target.rowId] = positions[rowId] ?? source.wagonId
  return next
}
