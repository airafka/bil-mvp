import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import { OrderRouteCell } from './OrderRouteCell'
import type { ServiceTransportOrder } from '../comprehensiveServiceOrder'

const order: ServiceTransportOrder = { id: 'order', kind: 'SHIPPING', status: 'DRAFT', terminalAreaId: 'area', transportType: 'VEHICLE' }
const render = (value: ServiceTransportOrder, disabled = false) => renderToStaticMarkup(<MemoryRouter><OrderRouteCell order={value} disabled={disabled} /></MemoryRouter>)
describe('route cell from service response', () => {
  it('renders the route link immediately from the supplied summary', () => {
    const html = render({ ...order, route: { id: 'route', code: 21326 } })
    expect(html).toContain('href="/routes/route"')
    expect(html).toContain('Рейс 21326')
    expect(html).not.toContain('Загрузка')
  })
  it('allows creating a route only for editable drafts', () => {
    expect(render(order)).toContain('Создать рейс')
    expect(render(order)).not.toContain('disabled')
    expect(render({ ...order, status: 'COMPLETED' })).toContain('disabled')
    expect(render(order, true)).toContain('disabled')
  })
})
