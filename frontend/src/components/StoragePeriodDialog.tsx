import { useEffect, useRef, useState } from 'react'
import { useApplicationClock } from '../applicationClock'
import { allDates, monthBounds, toggleMonth, type StorageDateRange } from '../storageDateRange'
import { AppOverlay } from './AppOverlay'
import { UiInput } from './FormControls'

const months = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь']

export function StoragePeriodDialog({ initial, onClose }: {
  initial: StorageDateRange; onClose: (dates?: StorageDateRange) => void
}) {
  const { clock } = useApplicationClock()
  const dialog = useRef<HTMLDialogElement>(null)
  const [dates, setDates] = useState(initial)
  const [year, setYear] = useState(() => Number((initial.from || initial.to || clock.date).slice(0, 4)) || Number(clock.date.slice(0, 4)))
  const bounds = monthBounds(dates)

  useEffect(() => {
    const panel = dialog.current
    panel?.showModal()
    return () => panel?.close()
  }, [])

  function close(result?: StorageDateRange) {
    dialog.current?.close()
    onClose(result)
  }

  return <AppOverlay><dialog ref={dialog} className="storage-period-dialog" aria-labelledby="storage-period-title"
    onCancel={event => { event.preventDefault(); close() }}>
    <form onSubmit={event => { event.preventDefault(); close(dates) }}>
      <header><h2 id="storage-period-title">Период хранения</h2>
        <button className="close-button" type="button" aria-label="Закрыть" onClick={() => close()}>×</button>
      </header>
      <div className="storage-period-year">
        <button className="secondary-button" type="button" aria-label="Предыдущий год" disabled={year <= 1} onClick={() => setYear(year - 1)}>‹</button>
        <strong aria-live="polite">{year}</strong>
        <button className="secondary-button" type="button" aria-label="Следующий год" disabled={year >= 9999} onClick={() => setYear(year + 1)}>›</button>
      </div>
      <div className="storage-months" role="group" aria-label={'Месяцы за ' + year + ' год'}>
        {months.map((name, index) => {
          const month = String(year).padStart(4, '0') + '-' + String(index + 1).padStart(2, '0')
          return <button key={month} type="button" className="secondary-button" aria-pressed={bounds.includes(month)}
            data-between={bounds.length === 2 && month > bounds[0] && month < bounds[1]}
            onClick={() => setDates(current => toggleMonth(current, month))}>{name}</button>
        })}
      </div>
      <div className="storage-period-dates">
        <label className="field">С<UiInput type="date" min="0001-01-01" max={dates.to || '9999-12-31'}
          required={!!dates.to} value={dates.from} onChange={e => setDates({ ...dates, from: e.target.value })} /></label>
        <label className="field">По<UiInput type="date" min={dates.from || '0001-01-01'} max="9999-12-31"
          required={!!dates.from} value={dates.to} onChange={e => setDates({ ...dates, to: e.target.value })} /></label>
      </div>
      <footer><button className="secondary-button" type="button" disabled={!dates.from && !dates.to}
        onClick={() => setDates(allDates)}>Очистить</button>
        <button className="primary-button" type="submit">Выбрать</button></footer>
    </form>
  </dialog></AppOverlay>
}
