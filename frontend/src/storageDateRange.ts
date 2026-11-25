export type StorageDateRange = { from: string; to: string }
export const allDates: StorageDateRange = { from: '', to: '' }

export function wholeMonths(first: string, last = first): StorageDateRange {
  const end = new Date(last + '-01T12:00:00Z')
  end.setUTCMonth(end.getUTCMonth() + 1, 0)
  return { from: first + '-01', to: end.toISOString().slice(0, 10) }
}

export function monthBounds(range: StorageDateRange): string[] {
  if (!range.from || !range.to || range.from > range.to) return []
  const first = range.from.slice(0, 7), last = range.to.slice(0, 7)
  // Old report links can contain manually entered dates.
  if (!validMonth(first) || !validMonth(last)) return []
  const full = wholeMonths(first, last)
  if (range.from !== full.from || range.to !== full.to) return []
  return first === last ? [first] : [first, last]
}

export function validMonth(month: string) {
  return /^(?!0000)\d{4}-(0[1-9]|1[012])$/.test(month)
}

export function toggleMonth(range: StorageDateRange, month: string): StorageDateRange {
  const bounds = monthBounds(range)
  if (bounds.includes(month)) {
    const remaining = bounds.find(value => value !== month)
    return remaining ? wholeMonths(remaining) : allDates
  }
  if (bounds.length === 1) {
    const [first, last] = [bounds[0], month].sort()
    return wholeMonths(first, last)
  }
  return wholeMonths(month)
}
