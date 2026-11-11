import { request } from './http'
import type { PagedResponse } from './domain'
export type PlacementCandidate = { id: string; number: string; receivingNumber: number | null; wagonCount: number; containerCount: number; departure: string; destination: string }
export type PlacementWagon = { id: string; number: string; feet: number | null; capacity: number | null }
export type PlacementContainer = { rowId: string; containerId: string; number: string; type: string; grossWeight: number; waybillId: string; waybillNumber: string; wagonId: string; selected: boolean }
export type PlacementLayout = { waybills: { id: string; number: string }[]; wagons: PlacementWagon[]; containers: PlacementContainer[]; version: string }
export type PlacementPosition = { wagonId: string; waybillId: string }
export type PlacementMap = Record<string, PlacementPosition>
export const positionOf = (c: PlacementContainer, positions: PlacementMap): PlacementPosition => positions[c.rowId] ?? { wagonId: c.wagonId, waybillId: c.waybillId }
export const placementCandidates = (query: string, page: number) => request<PagedResponse<PlacementCandidate>>('/api/waybills/placement/candidates?query='+encodeURIComponent(query)+'&page='+page)
export const placementWagons = (query: string) => request<PlacementWagon[]>('/api/waybills/placement/wagons?query='+encodeURIComponent(query))
export const placementPreview = (waybillIds: string[], layout?: PlacementLayout, addWagonId?: string) => request<PlacementLayout>('/api/waybills/placement/preview', { method: 'POST', body: JSON.stringify({ waybillIds, ...(layout ? { wagonIds: layout.wagons.map(w => w.id), expectedVersion: layout.version, addWagonId } : {}) }) })
export const savePlacement = (layout: PlacementLayout, positions: PlacementMap) => request<PlacementLayout>('/api/waybills/placement', { method: 'PUT', body: JSON.stringify({ waybillIds: layout.waybills.map(w => w.id), wagonIds: layout.wagons.map(w => w.id), version: layout.version, assignments: layout.containers.filter(c => c.selected).map(c => ({ rowId: c.rowId, ...positionOf(c, positions) })) }) })
export const containerFeet = (type: string): number | null => type === 'STANDARD_20' ? 20 : type === 'STANDARD_40' ? 40 : null
export function wagonFeet(rows: PlacementContainer[]): number | null {
  const lengths = rows.filter(c => c.selected).map(c => containerFeet(c.type))
  return lengths.some(n => n == null) ? null : lengths.reduce<number>((sum, n) => sum + (n ?? 0), 0)
}
// Keep unused platform length visible; compress an erroneous overloaded source so every KTK remains movable.
export function wagonTracks(wagon: PlacementWagon, rows: PlacementContainer[]) {
  const lengths = rows.filter(c => c.selected).map(c => containerFeet(c.type) ?? 20)
  const freeFeet = Math.max(0, (wagon.feet ?? 0) - lengths.reduce((sum, n) => sum + n, 0))
  const tracks = [...lengths, ...(freeFeet > 0 ? [freeFeet] : [])]
  return { freeFeet, columns: tracks.length ? tracks.map(n => 'minmax(0,' + n + 'fr)').join(' ') : '1fr' }
}
export type WagonGroup = { wagon: PlacementWagon; rows: PlacementContainer[] }
export function placementWagonGroups(layout: PlacementLayout, positions: PlacementMap): WagonGroup[] {
  const selected = layout.containers.filter(c => c.selected)
  return layout.wagons.map(wagon => ({ wagon, rows: selected.filter(c => positionOf(c, positions).wagonId === wagon.id) }))
}
export function wagonIssue(wagon: PlacementWagon, rows: PlacementContainer[]): string | null {
  if (!rows.some(c => c.selected)) return null
  const feet = wagonFeet(rows)
  if (feet == null) return 'Не определена футовость КТК'
  if (wagon.feet == null) return 'В справочнике не указана длина платформы'
  if (feet > wagon.feet) return 'Суммарная длина КТК превышает длину платформы'
  return null
}
export function transfer(positions: PlacementMap, rows: PlacementContainer[], rowId: string, wagonId: string, swapId?: string): PlacementMap {
  const source = rows.find(c => c.rowId === rowId)
  const target = swapId ? rows.find(c => c.rowId === swapId) : null
  if (!source?.selected || (swapId && !target?.selected)) return positions
  const from = positionOf(source, positions)
  const destination = target ? positionOf(target, positions).wagonId : wagonId
  if (destination === from.wagonId) return positions
  const next = { ...positions, [rowId]: { wagonId: destination, waybillId: source.waybillId } }
  if (target) next[target.rowId] = { wagonId: from.wagonId, waybillId: target.waybillId }
  return next
}
