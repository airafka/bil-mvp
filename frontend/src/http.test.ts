import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

function deferred() {
  let resolve!: (value: Response) => void
  const promise = new Promise<Response>(done => { resolve = done })
  return { promise, resolve }
}
const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 })
beforeEach(() => vi.resetModules())
afterEach(() => vi.unstubAllGlobals())

describe('API read sharing', () => {
  it('shares concurrent reads but fetches again after completion', async () => {
    const fetcher = vi.fn().mockResolvedValue(json({ value: 1 }))
    vi.stubGlobal('fetch', fetcher)
    const { request } = await import('./http')
    const first = request('/read')
    expect(request('/read')).toBe(first)
    expect(await first).toEqual({ value: 1 })
    fetcher.mockResolvedValueOnce(json({ value: 2 }))
    expect(await request('/read')).toEqual({ value: 2 })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('does not reuse a read started before a write or let it evict a newer read', async () => {
    const old = deferred(), fresh = deferred()
    const fetcher = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce(new Response(null, { status: 204 })).mockReturnValueOnce(fresh.promise)
    vi.stubGlobal('fetch', fetcher)
    const { request } = await import('./http')
    const previous = request('/read')
    await request('/write', { method: 'PATCH', body: '{}' })
    const current = request('/read')
    expect(current).not.toBe(previous)
    old.resolve(json({ version: 1 })); await previous
    expect(request('/read')).toBe(current)
    fresh.resolve(json({ version: 2 }))
    expect(await current).toEqual({ version: 2 })
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it('invalidates reads made during a write when the write completes', async () => {
    const writing = deferred(), during = deferred()
    const fetcher = vi.fn().mockReturnValueOnce(writing.promise).mockReturnValueOnce(during.promise).mockResolvedValueOnce(json('fresh'))
    vi.stubGlobal('fetch', fetcher)
    const { request } = await import('./http')
    const mutation = request('/write', { method: 'POST', body: '{}' })
    const intermediate = request('/read')
    writing.resolve(new Response(null, { status: 204 })); await mutation
    expect(await request('/read')).toBe('fresh')
    during.resolve(json('old')); await intermediate
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it('allows retry after API errors and preserves their message', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ detail: 'Конфликт' }), { status: 409 })).mockResolvedValueOnce(json('retry'))
    vi.stubGlobal('fetch', fetcher)
    const { request, ApiError } = await import('./http')
    await expect(request('/read')).rejects.toEqual(new ApiError('Конфликт'))
    expect(await request('/read')).toBe('retry')
  })

  it('keeps cancellation and custom headers isolated from shared reads', async () => {
    const fetcher = vi.fn().mockImplementation(() => Promise.resolve(json('ok')))
    vi.stubGlobal('fetch', fetcher)
    const { request } = await import('./http')
    const controller = new AbortController()
    await Promise.all([request('/read'), request('/read', { signal: controller.signal }), request('/read', { headers: new Headers({ Accept: 'application/json' }) })])
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(fetcher.mock.calls[1][1].signal).toBe(controller.signal)
    expect(fetcher.mock.calls[2][1].headers.get('Accept')).toBe('application/json')
    expect(fetcher.mock.calls[0][1].headers.has('Content-Type')).toBe(false)
  })

  it('never coalesces writes and preserves explicit content types', async () => {
    const fetcher = vi.fn().mockImplementation(() => Promise.resolve(new Response(null, { status: 204 })))
    vi.stubGlobal('fetch', fetcher)
    const { request } = await import('./http')
    await Promise.all([request('/write', { method: 'POST', body: '{}' }), request('/write', { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/problem+json' } })])
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher.mock.calls[0][1].headers.get('Content-Type')).toBe('application/json')
    expect(fetcher.mock.calls[1][1].headers.get('Content-Type')).toBe('application/problem+json')
  })
})
