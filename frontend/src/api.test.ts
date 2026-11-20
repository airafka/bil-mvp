import { afterEach, describe, expect, it, vi } from 'vitest'
import { lookupContainerStock } from './api'

afterEach(() => vi.unstubAllGlobals())

describe('container stock lookup batches', () => {
  it('requests 1001 IDs in sequential batches and preserves input order', async () => {
    const ids = Array.from({ length: 1001 }, (_, i) => `container-${i}`)
    const rows = ids.map(containerId => ({ containerId, ownerClientId: `owner-${containerId}`, status: 'ON_TERMINAL' }))
    let resolveFirst!: (response: Response) => void
    const firstResponse = new Promise<Response>(resolve => { resolveFirst = resolve })
    const fetcher = vi.fn()
      .mockReturnValueOnce(firstResponse)
      .mockResolvedValueOnce(Response.json(rows.slice(1000)))
    vi.stubGlobal('fetch', fetcher)

    const result = lookupContainerStock(ids)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0][0]).toBe('/api/container-owners/lookup')
    expect(JSON.parse(fetcher.mock.calls[0][1].body).containerIds).toEqual(ids.slice(0, 1000))
    resolveFirst(Response.json(rows.slice(0, 1000).reverse()))

    expect(await result).toEqual(rows)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(JSON.parse(fetcher.mock.calls[1][1].body).containerIds).toEqual(ids.slice(1000))
  })

  it('returns an empty list without sending an empty lookup', async () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    expect(await lookupContainerStock([])).toEqual([])
    expect(fetcher).not.toHaveBeenCalled()
  })
})
