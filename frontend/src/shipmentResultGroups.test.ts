import { expect, it } from 'vitest'
import type { ContainerQuantityDetails, OrderContainerDetails } from './domain'
import { remainingShipmentGroups } from './shipmentResultGroups'

it('показывает остаток по типоразмеру и грузу после частичного вывоза', () => {
  const empty: ContainerQuantityDetails = { id: 'empty', quantity: 1, type: 'STANDARD_40', empty: true, items: [] }
  const loaded = { ...empty, id: 'loaded', empty: false, quantity: 2, items: [{ id: 'item', etsngCodeId: 'code', etsngCode: '123456', weight: 150 }] }
  const row: OrderContainerDetails = { containerId: 'first', containerName: 'A', containerType: 'STANDARD_40', empty: true, cargo: null }
  const cargo = { etsngCodeId: 'code', etsngCodeName: '123456', weight: 150 }
  const remaining = remainingShipmentGroups({
    containerQuantities: [empty, loaded, { ...empty, id: 'small', type: 'STANDARD_20' }],
    containers: [],
    railwayCarriages: [{ railwayCarriageId: 'wagon', railwayCarriageCode: '123', containers: [
      row, { ...row, containerId: 'second', containerName: 'B', empty: false, cargo, cargoItems: [cargo] },
    ] }],
  })
  expect(remaining.map(group => [group.id, group.remaining])).toEqual([['loaded', 1], ['small', 1]])
})
