export type AvailableOrderService = {
  id: string
  name: string
}

export function validateServiceSelection(services: AvailableOrderService[], serviceId: string): string[] {
  return services.some(service => service.id === serviceId)
    ? []
    : ['Выберите доступную комплексную услугу']
}
