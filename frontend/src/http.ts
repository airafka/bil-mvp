type ApiProblem = { detail?: string; title?: string }

export class ApiError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ApiError'
  }
}

async function sendRequest<T>(url: string, options?: RequestInit): Promise<T> {
  const headers = new Headers(options?.headers)
  if (typeof options?.body === 'string' && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  const response = await fetch(url, { ...options, headers })
  if (!response.ok) {
    const problem = (await response.json().catch(() => ({}))) as ApiProblem
    throw new ApiError(problem.detail ?? problem.title ?? 'Не удалось выполнить запрос')
  }
  return response.status === 204 ? undefined as T : response.json() as Promise<T>
}

// Share only identical, concurrent default GETs; never cache settled responses.
const pendingGets = new Map<string, Promise<unknown>>()
export function request<T>(url: string, options?: RequestInit): Promise<T> {
  if ((options?.method ?? 'GET').toUpperCase() !== 'GET') {
    // A refresh must not reuse a read that started before or during a write.
    pendingGets.clear()
    return sendRequest<T>(url, options).finally(() => pendingGets.clear())
  }
  // Signals, credentials and custom headers belong to the individual caller.
  if (options) return sendRequest<T>(url, options)
  const existing = pendingGets.get(url)
  if (existing) return existing as Promise<T>
  const pending = sendRequest<T>(url).finally(() => {
    if (pendingGets.get(url) === pending) pendingGets.delete(url)
  })
  pendingGets.set(url, pending)
  return pending
}
