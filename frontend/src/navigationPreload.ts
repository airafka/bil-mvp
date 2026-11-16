// Load only the section module on user intent; mutable API data is never prefetched.
const modules: Record<string, () => Promise<unknown>> = {
  '/railway-carriages': () => import('./pages/RailwayCarriageRegistryPage'),
  '/containers': () => import('./pages/ContainerRegistryPage'),
  '/transport-carriers': () => import('./pages/TransportCatalogPages'),
  '/transport-drivers': () => import('./pages/TransportCatalogPages'),
  '/transport-vehicles': () => import('./pages/TransportCatalogPages'),
  '/routes': () => import('./pages/RoutePages'),
  '/waybills': () => import('./pages/WaybillRegistryPage'),
  '/complex-services': () => import('./pages/ComplexServicePages'),
  '/container-storage': () => import('./pages/ContainerStoragePage'),
  '/container-owners': () => import('./pages/ContainerStockPages'),
  '/receiving-orders': () => import('./pages/OrderListPage'),
  '/shipping-orders': () => import('./pages/OrderListPage'),
  '/service-orders': () => import('./pages/OwnershipOrderPages'),
  '/comprehensive-service-orders': () => import('./pages/ComprehensiveServiceOrderRegistryPage'),
  '/billing-charges': () => import('./pages/BillingChargesPage'),
  '/payment-invoices': () => import('./pages/PaymentInvoicePages'),
}
const pending = new Map<string, Promise<unknown>>()
export function preloadNavigation(path: string) {
  const load = modules[path]
  if (!load || pending.has(path)) return
  pending.set(path, load().catch(() => { pending.delete(path) }))
}
