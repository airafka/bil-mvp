import { createContext, useContext } from 'react'

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
export function shiftBusinessDate(date: string, days: number) {
  const value = new Date(date + 'T12:00:00Z')
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}
