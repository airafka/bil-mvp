import { createContext, useContext, useState } from 'react'

export type ApplicationClock = {
  date: string; fixedDate?: string; mode: 'SYSTEM' | 'FIXED'; timeZone: string;
  now: string; systemNow: string; version: number;
}
export type ClockContextValue = {
  clock: ApplicationClock; busy: boolean; error: string;
  refresh: () => Promise<void>; changeDate: (date: string | null) => Promise<void>;
}
export const ApplicationClockContext = createContext<ClockContextValue | null>(null)
export function useApplicationClock() {
  const value = useContext(ApplicationClockContext)
  if (!value) throw new Error('Application clock is not ready')
  return value
}
export const businessDateLabel = (date: string) => date.split('-').reverse().join('.')
// Form values are Moscow wall time, independent of the browser's time zone.
export function businessDateTime(clock: ApplicationClock) {
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: clock.timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(clock.now))
  return `${clock.date}T${time}`
}
export function useBusinessDateTime() {
  const { clock } = useApplicationClock()
  const [entered, setEntered] = useState<string>()
  // Follow the calendar until the user changes or clears the value.
  return [entered ?? businessDateTime(clock), setEntered] as const
}
export const businessDateTimeToInstant = (value: string) => new Date(value + '+03:00').toISOString()
export function instantToBusinessDateTime(value: string) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(value))
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(p => p.type === type)!.value
  return `${part('year').padStart(4, '0')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}`
}
export function shiftBusinessDate(date: string, days: number) {
  const value = new Date(date + 'T12:00:00Z')
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}
