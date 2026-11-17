import { describe, expect, it } from 'vitest'
import { businessDateTime, businessDateTimeToInstant, instantToBusinessDateTime, type ApplicationClock } from './applicationClock'

describe('form dates use the MVP calendar and Moscow time', () => {
  const clock: ApplicationClock = { date: '2096-02-29', mode: 'FIXED', timeZone: 'Europe/Moscow', now: '2096-02-28T21:05:00Z', systemNow: '2026-11-17T21:05:00Z', version: 1 }
  it('uses the working date and server time, including midnight and leap day', () => {
    expect(businessDateTime(clock)).toBe('2096-02-29T00:05')
    expect(businessDateTime({ ...clock, date: '2095-12-31' })).toBe('2095-12-31T00:05')
  })
  it('sends and edits the same Moscow date regardless of browser time zone', () => {
    const instant = businessDateTimeToInstant('2096-02-29T00:05')
    expect(instant).toBe('2096-02-28T21:05:00.000Z')
    expect(instantToBusinessDateTime(instant)).toBe('2096-02-29T00:05')
  })
})
