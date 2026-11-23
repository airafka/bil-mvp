import type { OrderDetails } from './domain'

export function remainingShipmentGroups(order: Pick<OrderDetails, 'containerQuantities' | 'containers' | 'railwayCarriages'>) {
  const groups = order.containerQuantities.map(group => ({ ...group, remaining: group.quantity }))
  const actual = [...order.containers, ...order.railwayCarriages.flatMap(wagon => wagon.containers)]
  for (const row of actual) {
    const cargo = row.cargoItems ?? (row.cargo ? [row.cargo] : [])
    const matches = groups.filter(plan => plan.remaining > 0 && plan.type === row.containerType && plan.empty === row.empty
      && plan.items.length === cargo.length && plan.items.every(item => cargo.some(actualItem =>
        actualItem.etsngCodeId === item.etsngCodeId && actualItem.weight === item.weight)))
    const group = matches.find(plan => plan.ownerClientId === row.ownerClientId) ?? matches.find(plan => !plan.ownerClientId) ?? matches[0]
    if (group) group.remaining--
  }
  return groups.filter(group => group.remaining > 0)
}
