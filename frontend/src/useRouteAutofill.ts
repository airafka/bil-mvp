import { useRef, useState } from 'react'
import { getTransportCatalog } from './api'
import { businessDateTime, useApplicationClock } from './applicationClock'
import type { TransportType } from './domain'
import type { TransportCatalogKind } from './transportCatalogs'

type Values = { date: string; carrier: string; driver: string; vehicle: string }
export async function routeAutofill(transport: TransportType, current: Values, date: string) {
  const next = { ...current, date: current.date || date }
  if (transport === 'VEHICLE') {
    const fields = [ ['carrier', 'carriers', 'перевозчика'], ['driver', 'drivers', 'водителя'], ['vehicle', 'vehicles', 'транспортное средство'] ] as const
    await Promise.all(fields.map(async ([field, kind, label]) => {
      if (next[field]) return
      const entry = (await getTransportCatalog(kind as TransportCatalogKind)).find(item => item.active)
      if (!entry) throw new Error(`Добавьте активного ${label} в справочник для автозаполнения рейса`)
      next[field] = entry.id
    }))
  }
  return next
}

export function useRouteAutofill(transport: TransportType, values: Values, apply: (next: Values) => void, onError: (message: string) => void) {
  const { clock } = useApplicationClock()
  const [filling, setFilling] = useState(false)
  const lock = useRef(false)
  async function fill() {
    if (lock.current) return
    lock.current = true; setFilling(true); onError('')
    try { apply(await routeAutofill(transport, values, businessDateTime(clock))) }
    catch (cause) { onError(cause instanceof Error ? cause.message : 'Не удалось заполнить рейс') }
    finally { lock.current = false; setFilling(false) }
  }
  return { filling, fill }
}
