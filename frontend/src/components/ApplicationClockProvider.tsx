import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { ApplicationClockContext, type ApplicationClock } from '../applicationClock'
import { request } from '../http'

export function ApplicationClockProvider({ children }: { children: ReactNode }) {
  const [clock, setClock] = useState<ApplicationClock | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const accept = useCallback((next: ApplicationClock) => setClock(previous =>
    !previous || next.version > previous.version || (next.version === previous.version && Date.parse(next.systemNow) >= Date.parse(previous.systemNow)) ? next : previous), [])
  const refresh = useCallback(() => request<ApplicationClock>('/api/application-clock')
    .then(next => { accept(next); setError('') })
    .catch(cause => { setError(cause instanceof Error ? cause.message : 'Не удалось загрузить рабочую дату') }), [accept])
  useEffect(() => {
    void refresh()
    const onVisible = () => { if (document.visibilityState === 'visible') void refresh() }
    const timer = window.setInterval(onVisible, 15000)
    window.addEventListener('focus', onVisible)
    document.addEventListener('visibilitychange', onVisible)
    const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('billing-application-clock')
    if (channel) channel.onmessage = () => { void refresh() }
    return () => { clearInterval(timer); window.removeEventListener('focus', onVisible); document.removeEventListener('visibilitychange', onVisible); channel?.close() }
  }, [refresh])
  async function changeDate(date: string | null) {
    if (!clock || busy) return
    setBusy(true); setError('')
    try {
      accept(await request<ApplicationClock>('/api/application-clock', { method: 'PUT', body: JSON.stringify({ date, version: clock.version }) }))
      if (typeof BroadcastChannel !== 'undefined') {
        const channel = new BroadcastChannel('billing-application-clock'); channel.postMessage('changed'); channel.close()
      }
    } catch (cause) {
      await refresh()
      setError(cause instanceof Error ? cause.message : 'Не удалось изменить рабочую дату')
    } finally { setBusy(false) }
  }
  if (!clock) return <div className="app-shell"><main className="content">
    {error ? <div role="alert">{error} <button className="secondary-button" onClick={() => { void refresh() }}>Повторить</button></div> : <div role="status">Загружаем рабочую дату…</div>}
  </main></div>
  return <ApplicationClockContext.Provider value={{ clock, busy, error, refresh, changeDate }}>{children}</ApplicationClockContext.Provider>
}
