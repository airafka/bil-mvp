import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { UiInput } from '../components/FormControls'
import { ActionIcon } from '../components/ActionIcon'
import { getWaybillStationName } from '../waybillOptions'
import { placementCandidates, placementPreview, savePlacement, transfer, positionOf, wagonIssue, wagonTracks, waybillWagons, containerFeet, type PlacementCandidate, type PlacementContainer, type PlacementLayout, type PlacementMap } from '../waybillPlacement'
import type { PagedResponse } from '../domain'
import './WaybillPlacementPage.css'

function Chassis() {
  return <svg className="wagon-chassis" viewBox="0 0 600 66" preserveAspectRatio="none" aria-hidden="true">
    <path d="M4 6H596V21H4z" fill="#617184"/><path d="M12 4H588V9H12z" fill="#97a6b5"/>
    <path d="M10 14H590M18 23H582" stroke="#37465a" strokeWidth="3"/>
    {[76, 440].map(x => <g key={x} transform={'translate('+x+',17)'}>
      <path d="M-18 2H100L93 26H-11z" fill="#435167"/><path d="M4 8H78M12 14H70" stroke="#94a3b8" strokeWidth="3"/>
      {[7,75].map(w => <g key={w}><circle cx={w} cy="25" r="20" fill="#263346"/><circle cx={w} cy="25" r="13" fill="#7b8999"/><circle cx={w} cy="25" r="6" fill="#d5dce4"/><circle cx={w} cy="25" r="2" fill="#42526a"/></g>)}
    </g>)}
  </svg>
}

export function WaybillPlacementPage() {
  const [data, setData] = useState<PagedResponse<PlacementCandidate> | null>(null)
  const [page, setPage] = useState(0)
  const [selected, setSelected] = useState<Record<string, PlacementCandidate>>({})
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false)
  const [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [layout, setLayout] = useState<PlacementLayout | null>(null), [positions, setPositions] = useState<PlacementMap>({})
  const [picked, setPicked] = useState<string | null>(null), [over, setOver] = useState<string | null>(null)
  const lock = useRef(false), drag = useRef<string | null>(null)
  const ids = Object.keys(selected)
  const changed = layout?.containers.filter(c => c.selected && (positionOf(c, positions).wagonId !== c.wagonId || positionOf(c, positions).waybillId !== c.waybillId)).length ?? 0
  const rowsOn = (id: string) => layout?.containers.filter(c => c.selected && positionOf(c, positions).wagonId === id) ?? []
  const invalid = layout?.wagons.some(w => wagonIssue(w, rowsOn(w.id))) ?? false
  useEffect(() => {
    if (layout) return
    let active = true
    placementCandidates('', page).then(v => { if (active) setData(v) }).catch(e => { if (active) setError(String(e)) }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [page, layout])
  useEffect(() => {
    if (!changed) return
    const handler = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [changed])
  function toggle(bill: PlacementCandidate) {
    if (lock.current) return
    setSelected(prev => { const next = { ...prev }; if (next[bill.id]) delete next[bill.id]; else if (Object.keys(next).length < 200) next[bill.id] = bill; return next })
  }
  async function open() {
    if (lock.current || !ids.length) return
    lock.current = true; setBusy(true); setError(''); setNotice('')
    try { setLayout(await placementPreview(ids)); setPositions({}); setPicked(null) }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { lock.current = false; setBusy(false) }
  }
  function move(rowId: string, wagonId: string, swapId?: string) {
    if (!layout || busy) return
    setPositions(prev => transfer(prev, layout.containers, rowId, wagonId, swapId)); setPicked(null); setOver(null); setNotice(''); setError('')
  }
  async function save() {
    if (!layout || lock.current || invalid || !changed) return
    lock.current = true; setBusy(true); setError(''); setNotice('')
    try { const result = await savePlacement(layout, positions); setLayout(result); setPositions({}); setPicked(null); setNotice('Размещение КТК сохранено. Накладные обновлены.') }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { lock.current = false; setBusy(false) }
  }
  function containerCard(c: PlacementContainer) {
    const { wagonId, waybillId } = positionOf(c, positions)
    return <div key={c.rowId} className={'ktk-unit' + (!c.selected ? ' ktk-locked' : '')} data-row-id={c.rowId} data-wagon-id={wagonId} data-waybill-id={waybillId}
      draggable={c.selected && !busy} onDragStart={e => { drag.current = c.rowId; setPicked(c.rowId); e.dataTransfer.setData('text/plain', c.rowId); e.dataTransfer.effectAllowed = 'move' }}
      onDragEnd={() => { drag.current = null; setOver(null) }}
      onDragOver={e => { if (c.selected && drag.current && drag.current !== c.rowId) { e.preventDefault(); e.stopPropagation() } }}
      onDrop={e => { e.preventDefault(); e.stopPropagation(); const source = drag.current; if (source && c.selected) move(source, wagonId, c.rowId); drag.current = null }}>
      <div className="ktk-waybill"><svg width="14" height="16" viewBox="0 0 14 16" fill="none" aria-hidden="true"><path d="M2 1h6l4 4v10H2zM8 1v4h4M4 8h6M4 11h6" stroke="currentColor" /></svg><span title={'Накладная ' + c.waybillNumber}>№ <b>{c.waybillNumber}</b></span></div>
      <button type="button" className="ktk-box" data-picked={picked === c.rowId} disabled={busy || !c.selected}
        title={'КТК ' + c.number + ' · ' + (containerFeet(c.type) ?? '—') + 'FT · накладная ' + c.waybillNumber + (!c.selected ? ' · Накладная не выбрана' : '')} aria-pressed={picked === c.rowId} aria-label={'Выбрать КТК ' + c.number + ', накладная ' + c.waybillNumber}
        onClick={() => { if (picked && picked !== c.rowId) move(picked, wagonId, c.rowId); else setPicked(picked === c.rowId ? null : c.rowId) }}>
        <span className="ktk-type">{containerFeet(c.type) ?? '—'}FT</span><strong>{c.number}</strong>
        <span className="ktk-door" aria-hidden="true" />
      </button>
    </div>
  }
  return <section className="placement-page">
    <header className="page-header"><div><h1>Редактировать накладные</h1></div><div className="header-actions">
      {layout ? <><button className="secondary-button" disabled={busy} onClick={() => { if (!changed || window.confirm('Изменения не сохранены. Вернуться к выбору накладных?')) { setLayout(null); setLoading(true); setError(''); setNotice('') } }}>Назад</button><button className="primary-button" disabled={busy || !changed || invalid} onClick={save}>{busy ? 'Сохраняем…' : 'Сохранить'}</button></> : <button className="primary-button" disabled={busy || !ids.length} onClick={open}>{busy ? 'Загружаем…' : 'Далее'}</button>}
      <Link className="close-button" to="/waybills" aria-label="Закрыть редактор" onClick={e => { if (busy || (changed && !window.confirm('Изменения не сохранены. Закрыть редактор?'))) e.preventDefault() }}><ActionIcon name="close" /></Link>
    </div></header>
    {error && <div className="placement-alert" role="alert">{error}{layout && <button className="secondary-button" disabled={busy} onClick={() => { if (!changed || window.confirm('Загрузить актуальную схему? Несохранённые перемещения будут сброшены.')) open() }}>Загрузить заново</button>}</div>}
    {notice && <div className="placement-success" role="status">{notice}</div>}
    {!layout ? <div className="table-card placement-selection">
      <div className="table-wrap"><table><thead><tr><th><UiInput type="checkbox" aria-label="Выбрать накладные на странице" disabled={loading || busy || !data?.items.length} checked={!!data?.items.length && data.items.every(b => !!selected[b.id])} onChange={e => { const add = e.target.checked; setSelected(prev => { const next = { ...prev }; data?.items.forEach(b => { if (!add) delete next[b.id]; else if (Object.keys(next).length < 200) next[b.id] = b }); return next }) }} /></th><th>Накладная</th><th>Кол-во вагонов</th><th>Кол-во КТК</th><th>Маршрут</th></tr></thead><tbody>
        {loading ? <tr><td colSpan={5}>Загружаем накладные…</td></tr> : data?.items.map(b => <tr key={b.id}><td><UiInput type="checkbox" disabled={busy || (!selected[b.id] && ids.length >= 200)} checked={!!selected[b.id]} aria-label={'Выбрать накладную ' + b.number} onChange={() => toggle(b)} /></td><td>{b.number}</td><td>{b.wagonCount}</td><td>{b.containerCount}</td><td>{getWaybillStationName(Number(b.departure))} → {getWaybillStationName(Number(b.destination))}</td></tr>)}
        {!loading && !data?.items.length && <tr><td colSpan={5}>Подходящих накладных нет</td></tr>}
      </tbody></table></div><div className="pagination"><button disabled={loading || busy || page === 0} onClick={() => { setPage(page - 1); setLoading(true) }}>Назад</button><span>Страница {page + 1} из {Math.max(1, data?.totalPages ?? 1)}</span><button disabled={loading || busy || page + 1 >= (data?.totalPages ?? 0)} onClick={() => { setPage(page + 1); setLoading(true) }}>Далее</button></div>
    </div> : <>
      <div className="wagon-grid" aria-label="Схема размещения КТК">{waybillWagons(layout, positions).map(group => { const { wagon: w, rows } = group, issue = wagonIssue(w, group.physicalRows), tracks = wagonTracks(w, rows, group.occupiedFeet), editable = !group.waybillId || layout.waybills.some(b => b.id === group.waybillId); return <section key={group.key} className="wagon-card" data-wagon={w.id} data-waybill={group.waybillId ?? undefined} data-over={over === group.key} data-invalid={!!issue} aria-label={'Вагон ' + w.number + (group.waybillNumber ? ', накладная ' + group.waybillNumber : '')}
        onDragOver={e => { if (drag.current && !busy && editable) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setOver(group.key) } }} onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(null) }}
        onDrop={e => { e.preventDefault(); if (drag.current && editable) move(drag.current, w.id); drag.current = null }}>
        <div className="wagon-load" data-empty={!rows.length} style={{ gridTemplateColumns: tracks.columns }}>{rows.map(containerCard)}{!rows.length && <button type="button" className="wagon-empty-slot" disabled={!picked || busy || !editable} onClick={() => { if (picked && editable) move(picked, w.id) }} aria-label={'Переместить выбранный КТК на вагон ' + w.number}><span aria-hidden="true">＋</span>{group.waybillNumber && <span>№{group.waybillNumber}</span>}{picked ? 'Разместить здесь' : 'Нет КТК'}</button>}{group.occupiedFeet > 0 && <div className="wagon-other-load" role="img" title={'Занято КТК других выбранных накладных: ' + group.occupiedFeet + 'FT'} aria-label={'Занято КТК других выбранных накладных: ' + group.occupiedFeet + 'FT'} />}{!!rows.length && tracks.freeFeet > 0 && <button type="button" className="wagon-free-slot" title={'Свободно ' + tracks.freeFeet + ' футов'} aria-label={'Переместить выбранный КТК на свободную часть вагона ' + w.number} disabled={!picked || busy || !editable} onClick={() => { if (picked && editable) move(picked, w.id) }} />}</div>
        <Chassis /><div className="wagon-caption"><button type="button" className="wagon-target" disabled={!picked || busy || !editable} title={picked ? 'Переместить выбранный КТК на этот вагон' : undefined} aria-label={'Переместить выбранный КТК на вагон ' + w.number} onClick={() => { if (picked && editable) move(picked, w.id) }}><strong>№{w.number}({w.feet ?? '—'}FT)</strong></button></div>
        {issue && <p className="wagon-issue" role="status">{issue}</p>}
      </section> })}</div>
    </>}
  </section>
}
