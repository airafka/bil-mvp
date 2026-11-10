import { describe, expect, it } from 'vitest'
import { validateServiceSelection } from './serviceWaybillValidation'

const services = [
  { id: 'wagon', name: 'Повагонная услуга' },
  { id: 'train', name: 'Услуга в составе поезда' },
]

describe('service selection', () => {
  it.each(['wagon', 'train'])('allows %s independently of waybill composition', id => {
    expect(validateServiceSelection(services, id)).toEqual([])
  })
  it.each(['', 'unavailable'])('rejects missing or unavailable service %s', id => {
    expect(validateServiceSelection(services, id)).toEqual(['Выберите доступную комплексную услугу'])
  })
  it('rejects selection when available services have not loaded', () => {
    expect(validateServiceSelection([], 'wagon')).toHaveLength(1)
  })
})
