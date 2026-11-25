import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import type { ReferenceOption } from '../domain'
import { UiInput } from './FormControls'

export function StorageContainerFilter({ value, containers, onChange }: {
  value: string; containers: ReferenceOption[]; onChange: (value: string) => void
}) {
  const id = useId()
  const listId = id + '-options'
  const input = useRef<HTMLInputElement>(null)
  const activeOption = useRef<HTMLLIElement>(null)
  const [menu, setMenu] = useState<'closed' | 'matches' | 'all'>('closed')
  const [active, setActive] = useState(-1)
  const open = menu !== 'closed'
  const needle = menu === 'all' ? '' : value.trim().toLowerCase()
  const options = containers.filter(item => item.name.toLowerCase().includes(needle)).map(item => item.name)
  if (!needle) options.unshift('')

  useEffect(() => {
    activeOption.current?.scrollIntoView({ block: 'nearest' })
  }, [active])

  function close() {
    setMenu('closed')
    setActive(-1)
  }

  function choose(number: string) {
    onChange(number)
    close()
  }

  function handleKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!open) setMenu('matches')
      const last = options.length - 1
      if (event.key === 'ArrowDown') setActive(Math.min(active + 1, last))
      else setActive(active <= 0 ? last : active - 1)
    } else if (open && event.key === 'Enter' && options[active] !== undefined) {
      event.preventDefault()
      choose(options[active])
    } else if (open && event.key === 'Escape') {
      event.preventDefault()
      close()
    }
  }

  return <div className="field storage-number-field">
    <label htmlFor={id}>Номер КТК</label>
    <div className="storage-number-picker">
      <UiInput ref={input} id={id} value={value} role="combobox" aria-autocomplete="list" aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && options[active] !== undefined ? listId + '-' + active : undefined}
        placeholder="Все КТК" autoComplete="off" spellCheck={false} onFocus={() => setMenu('matches')}
        onClick={() => setMenu('matches')} onBlur={close} onKeyDown={handleKey}
        onChange={event => { onChange(event.target.value); setMenu('matches'); setActive(-1) }} />
      <button className="storage-number-toggle" type="button" tabIndex={-1}
        aria-label={open ? 'Скрыть номера КТК' : 'Показать номера КТК'} onMouseDown={event => event.preventDefault()}
        onClick={() => { input.current?.focus(); if (open) close(); else setMenu('all') }} />
      {open && <ul id={listId} role="listbox" aria-label="Номера КТК" className="storage-number-options">
        {options.map((number, index) => <li key={number} role="option" id={listId + '-' + index}
          aria-selected={index === active} ref={index === active ? activeOption : undefined}
          onMouseDown={event => event.preventDefault()} onClick={() => choose(number)}>{number || 'Все КТК'}</li>)}
        {!options.length && <li role="option" aria-disabled="true" aria-selected={false}>Совпадений нет</li>}
      </ul>}
    </div>
  </div>
}
