import { beforeEach, expect, it, vi } from 'vitest'
import { getTransportCatalog } from './api'
import { routeAutofill } from './useRouteAutofill'
import type { TransportCatalogEntry } from './transportCatalogs'
vi.mock('./api', () => ({ getTransportCatalog: vi.fn() }))
const empty = { date: '', carrier: '', driver: '', vehicle: '' }
beforeEach(() => vi.resetAllMocks())
it('fills missing fields using active entries and the working date', async () => {
  vi.mocked(getTransportCatalog).mockImplementation(async kind => [{ id: 'inactive', active: false }, { id: kind, active: true }] as TransportCatalogEntry[])
  expect(await routeAutofill('VEHICLE', empty, '2096-02-29T12:00')).toEqual({ date: '2096-02-29T12:00', carrier: 'carriers', driver: 'drivers', vehicle: 'vehicles' })
})
it('preserves manual selections and reports an empty catalog without changing the form', async () => {
  vi.mocked(getTransportCatalog).mockResolvedValue([])
  const current = { ...empty, date: '2096-03-01T15:00', carrier: 'chosen' }
  await expect(routeAutofill('VEHICLE', current, '2096-02-29T12:00')).rejects.toThrow('Добавьте активного')
  expect(getTransportCatalog).not.toHaveBeenCalledWith('carriers')
  expect(current).toEqual({ ...empty, date: '2096-03-01T15:00', carrier: 'chosen' })
})
it('does not load vehicle catalogs for railway transport', async () => {
  expect(await routeAutofill('RAILWAY', empty, '2096-02-29T12:00')).toEqual({ ...empty, date: '2096-02-29T12:00' })
  expect(getTransportCatalog).not.toHaveBeenCalled()
})
