import { describe, expect, it } from 'vitest'
import { allDates, monthBounds, toggleMonth, wholeMonths } from './storageDateRange'

describe('storage report month selection', () => {
  it('uses the last calendar day including leap February', () => {
    expect(wholeMonths('2026-11')).toEqual({ from: '2026-11-01', to: '2026-11-30' })
    expect(wholeMonths('2028-02').to).toBe('2028-02-29')
    expect(wholeMonths('2026-02').to).toBe('2026-02-28')
  })

  it('selects across years in either order and toggles individual boundaries off', () => {
    const first = '2026-11', last = '2027-02'
    const range = wholeMonths(first, last)
    expect(toggleMonth(wholeMonths(last), first)).toEqual(range)
    expect(toggleMonth(wholeMonths(first), last)).toEqual(range)
    expect(toggleMonth(range, first)).toEqual(wholeMonths(last))
    expect(toggleMonth(range, last)).toEqual(wholeMonths(first))
    expect(toggleMonth(wholeMonths(first), first)).toEqual(allDates)
  })

  it('starts a new selection after two boundaries or a manually entered partial month', () => {
    const partial = { from: '2026-06-28', to: '2026-07-02' }
    expect(monthBounds(partial)).toEqual([])
    expect(toggleMonth(partial, '2026-07')).toEqual(wholeMonths('2026-07'))
    expect(toggleMonth(wholeMonths('2026-04', '2026-06'), '2026-05')).toEqual(wholeMonths('2026-05'))
  })
})
