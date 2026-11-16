import { useId, useRef, useState } from 'react'
import { businessDateLabel, shiftBusinessDate, useApplicationClock } from '../applicationClock'
import { UiInput } from './FormControls'
import './ApplicationCalendar.css'

export function ApplicationCalendar() {
  const { clock, busy, error, refresh, changeDate } = useApplicationClock()
  const id = useId()
  const panel = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ top: 48, left: 8 })
  const [draft, setDraft] = useState({ source: clock.date, value: clock.date })
  const selected = draft.source === clock.date ? draft.value : clock.date
  return <div className="application-clock-actions">
    <button type="button" className="secondary-button application-clock-trigger" data-mode={clock.mode}
      aria-label={'Рабочая дата: ' + businessDateLabel(clock.date)} aria-expanded={open} aria-controls={id}
      title={clock.mode === 'SYSTEM' ? 'Рабочая дата следует системной' : 'Установлена рабочая дата MVP'}
      onClick={event => {
        if (panel.current?.matches(':popover-open')) { panel.current.hidePopover(); return }
        const rect = event.currentTarget.getBoundingClientRect()
        setPosition({ left: Math.max(8, Math.min(rect.right - 340, window.innerWidth - 348)), top: Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - 280)) })
        panel.current?.showPopover()
        panel.current?.querySelector('input')?.focus()
      }}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M7 3v4m10-4v4M3 11h18" /></svg>
      <span className="application-clock-label">Дата MVP:</span> {businessDateLabel(clock.date)}{error && <span aria-label="Ошибка календаря">!</span>}
    </button>
    <div ref={panel} id={id} popover="auto" className="application-calendar" style={position} onToggle={event => setOpen(event.newState === 'open')}>
      <form onSubmit={event => { event.preventDefault(); if (selected) void changeDate(selected) }}>
        <label className="field"><span>Рабочая дата</span><UiInput type="date" required min="0001-01-01" max="9999-12-31"
          value={selected} disabled={busy} onChange={event => setDraft({ source: clock.date, value: event.target.value })} /></label>
        <div className="application-calendar-buttons">
          <button type="button" className="secondary-button" aria-label="Предыдущий день" title="Предыдущий день" disabled={busy || clock.date === '0001-01-01'} onClick={() => { void changeDate(shiftBusinessDate(clock.date, -1)) }}>‹</button>
          <button type="button" className="secondary-button" aria-label="Следующий день" title="Следующий день" disabled={busy || clock.date === '9999-12-31'} onClick={() => { void changeDate(shiftBusinessDate(clock.date, 1)) }}>›</button>
          <button type="submit" className="primary-button" disabled={busy || !selected}>{busy ? 'Сохраняем…' : 'Применить'}</button>
          <button type="button" className="secondary-button" disabled={busy} onClick={() => { void changeDate(null) }}>Сегодня</button>
        </div>
      </form>
      <p className="application-calendar-mode">{clock.mode === 'SYSTEM' ? 'Системная дата' : 'Рабочая дата MVP'} · московское время</p>
      {error && <div className="application-calendar-error" role="alert">{error} <button type="button" onClick={() => { void refresh() }}>Обновить</button></div>}
    </div>
  </div>
}
