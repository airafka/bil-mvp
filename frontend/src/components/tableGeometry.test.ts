import { describe, expect, it } from 'vitest'
import { tableGeometry, responsiveColumnGeometry } from './tableGeometry'

describe('table geometry', () => {
  const columns = [{ width: 44, fixed: true }, { width: 140, fixed: false }, { width: 210, fixed: false }]
  it('keeps columns readable in a narrow scroll area', () => {
    expect(tableGeometry(320, columns)).toEqual({ width: 394, columns: [44, 140, 210] })
  })
  it('fills a wide frame without stretching selection slots', () => {
    expect(tableGeometry(744, columns)).toEqual({ width: 744, columns: [44, 280, 420] })
  })
  it('honours explicit minima and remains stable after shrink/grow', () => {
    const before = tableGeometry(600, columns, 800)
    tableGeometry(1000, columns, 800)
    expect(tableGeometry(600, columns, 800)).toEqual(before)
    expect(before.columns.reduce((sum, value) => sum + value, 0)).toBe(800)
  })
})


describe('browser-resolved column widths', () => {
  it('keeps selection fixed and distributes the fractional remaining width proportionally', () => {
    expect(responsiveColumnGeometry([{ width: 44, fixed: true }, { width: 100, fixed: false }, { width: 300, fixed: false }]))
      .toEqual({ minimum: 444, columns: ['44px', '25%', '75%'] })
  })
  it('keeps a readable minimum without measuring the current viewport', () => {
    expect(responsiveColumnGeometry([{ width: 120, fixed: false }, { width: 120, fixed: false }], 800))
      .toEqual({ minimum: 800, columns: ['50%', '50%'] })
  })
  it('handles fixed-only tables without division by zero', () => {
    expect(responsiveColumnGeometry([{ width: 44, fixed: true }])).toEqual({ minimum: 44, columns: ['44px'] })
  })
})
