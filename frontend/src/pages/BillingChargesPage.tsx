import { TableReveal } from '../components/TableReveal'
import { Notification } from '../components/Notification'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { getBillingCharges } from '../api'
import { updateResponsiveTable } from '../components/useResponsiveTables'
import type { BillingChargePage } from '../billing'

const money = (value: number) => value.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export function BillingChargeTotals({ totalWithoutVat, totalWithVat }: Pick<BillingChargePage, 'totalWithoutVat' | 'totalWithVat'>) {
  return <dl className="service-charge-totals"><div><dt>Начислено без НДС, ₽</dt><dd>{money(totalWithoutVat)}</dd></div><div><dt>Начислено с НДС, ₽</dt><dd>{money(totalWithVat)}</dd></div></dl>
}

export function BillingCharges({ comprehensiveServiceOrderId, refreshKey = '', active = true }: { comprehensiveServiceOrderId?: string; refreshKey?: string; active?: boolean }) {
  const [result, setResult] = useState<{ key: string; data: BillingChargePage } | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [page, setPage] = useState(0)
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null)
  const table = useRef<HTMLTableElement>(null)
  const requestKey = JSON.stringify([comprehensiveServiceOrderId, page, refreshKey, attempt])
  const data = result?.data
  const error = failure?.key === requestKey ? failure.message : ''
  const loading = result?.key !== requestKey && !error
  useEffect(() => {
    let current = true
    getBillingCharges(comprehensiveServiceOrderId, page).then(value => { if (current) { setResult({ key: requestKey, data: value }); setFailure(null) } })
      .catch((cause: unknown) => { if (current) setFailure({ key: requestKey, message: cause instanceof Error ? cause.message : 'Не удалось загрузить начисления' }) })
    return () => { current = false }
  }, [comprehensiveServiceOrderId, page, requestKey])
  useLayoutEffect(() => {
    if (active && table.current) updateResponsiveTable(table.current)
  }, [active, data])
  const columns = comprehensiveServiceOrderId ? [44, 150, 220, 170, 170] : [110, 170, 100, 110, 135, 400, 115, 115]

  return <section id={comprehensiveServiceOrderId ? 'service-charges' : undefined} className="service-order-section billing-charges-panel" aria-label="Начисления">
    {active && error && <Notification kind="error">{error}<button className="secondary-button" onClick={() => setAttempt(value => value + 1)}>Повторить</button></Notification>}
    {!comprehensiveServiceOrderId && data && <BillingChargeTotals {...data} />}
    <TableReveal loading={loading} className="table-wrap service-compact-table" enabled={!comprehensiveServiceOrderId}>
      <table ref={table} className={comprehensiveServiceOrderId ? 'service-charge-table' : 'billing-charge-registry-table'} data-responsive-min-width={comprehensiveServiceOrderId ? 754 : 1100}>
        <colgroup>{columns.map((width, index) => <col key={index} style={{ width }} />)}</colgroup>
        <thead><tr>
          {comprehensiveServiceOrderId && <th scope="col" className="composition-index">№</th>}
          <th scope="col">Дата оказания</th>
          {!comprehensiveServiceOrderId && <><th scope="col">Клиент</th><th scope="col">Договор</th><th scope="col">Заявка на услугу</th></>}
          <th scope="col">КТК</th>{!comprehensiveServiceOrderId && <th scope="col">Услуга</th>}<th scope="col">Без НДС, ₽</th><th scope="col">С НДС, ₽</th>
        </tr></thead>
        <tbody>{data?.items.length ? data.items.map((item, index) => <tr key={item.id}>
          {comprehensiveServiceOrderId && <td className="composition-index">{data.page * data.size + index + 1}</td>}
          <td>{new Date(item.performedAt).toLocaleDateString('ru-RU')}</td>
          {!comprehensiveServiceOrderId && <><td>{item.clientName}</td><td>{item.contractName}</td><td><Link to={'/comprehensive-service-orders/'+item.comprehensiveServiceOrderId}>{item.comprehensiveServiceOrderCode}</Link></td></>}
          <td>{item.containerName}</td>{!comprehensiveServiceOrderId && <td>{item.serviceName}</td>}<td>{money(item.amountWithoutVat)}</td><td>{money(item.amountWithVat)}</td>
        </tr>) : <tr><td colSpan={columns.length} className="table-message">{loading ? 'Загружаем начисления…' : error ? 'Начисления не загружены' : 'Начислений пока нет'}</td></tr>}</tbody>
      </table>
    </TableReveal>
    {data && data.total > data.size && <div className="pagination"><button disabled={loading || page === 0} onClick={() => setPage(value => value - 1)}>Назад</button><span>Страница {data.page + 1} из {Math.ceil(data.total / data.size)}</span><button disabled={loading || (page + 1) * data.size >= data.total} onClick={() => setPage(value => value + 1)}>Далее</button></div>}
  </section>
}

export function BillingChargesPage() {
  return <section className="form-page service-dashboard"><div className="page-header"><h1>Оказанные услуги</h1></div><BillingCharges /></section>
}
