import { useLayoutEffect } from 'react'
import { responsiveColumnGeometry } from './tableGeometry'

const geometryCache = new WeakMap<HTMLTableElement, { key: string; cells: HTMLTableCellElement[] }>()

function updateScrollAccess(table: HTMLTableElement, available: number) {
  const parent = table.parentElement
  if (!parent || available <= 0) return
  const minimum = Number.parseFloat(table.style.getPropertyValue('--responsive-table-min-width')) || 0
  if (minimum > available) {
    if (!parent.hasAttribute('tabindex')) { parent.tabIndex = 0; parent.dataset.tableScrollFocus = 'true' }
    if (!parent.hasAttribute('aria-label')) { parent.setAttribute('aria-label', 'Таблица с горизонтальной прокруткой'); parent.dataset.tableScrollLabel = 'true' }
  } else {
    if (parent.dataset.tableScrollFocus) { parent.removeAttribute('tabindex'); delete parent.dataset.tableScrollFocus }
    if (parent.dataset.tableScrollLabel) { parent.removeAttribute('aria-label'); delete parent.dataset.tableScrollLabel }
  }
}

/** Apply the shared geometry before a newly shown table is painted. */
export function updateResponsiveTable(table: HTMLTableElement) {
  const parent = table.parentElement
  if (!parent) return
  // Geometry depends on declared columns, never on a layout read. ResizeObserver
  // supplies the frame width separately, without forcing an intermediate layout.
  parent.classList.add('responsive-table-scroll')
  table.classList.add('responsive-table')
  const headings = [...(table.tHead?.rows ?? [])].at(-1)
  const columns = [...table.querySelectorAll<HTMLTableColElement>(':scope > colgroup > col')]
  const cells = [...(headings?.cells ?? [])]
  const geometry = cells.map((cell, index) => {
    const declared = columns[index]?.style.width || cell.style.width
    const hint = declared?.endsWith('px') ? Number.parseFloat(declared) : 0
    const label = cell.textContent?.trim() || ''
    const fixed = cell.matches('.composition-index,.registry-index,.registry-actions,.cargo-editor-actions,.route-picker-choice,.container-col-index,.container-col-action') || !!columns[index]?.matches('.route-picker-choice') || (hint > 0 && hint <= 60) || !!cell.querySelector('input[type="checkbox"]')
    const width = fixed ? 44 : hint || (/собственник|клиент|договор|услуг|отправитель|получатель|наименование|комментарий/i.test(label) ? 220 : 140)
    return { width, fixed }
  })
  const layout = responsiveColumnGeometry(geometry, Number(table.dataset.responsiveMinWidth) || 0)
  const key = layout.minimum + ':' + layout.columns.join('|')
  const previous = geometryCache.get(table)
  if (previous?.key !== key || cells.some((cell, index) => previous.cells[index] !== cell)) {
    if (cells.every(cell => cell.colSpan === 1)) cells.forEach((cell, index) => {
      cell.style.setProperty('--responsive-column-width', layout.columns[index])
    })
    table.style.setProperty('--responsive-table-min-width', layout.minimum + 'px')
    geometryCache.set(table, { key, cells })
  }
}

/** Keep native tables, hierarchy and controls intact; only their frame scrolls. */
export function useResponsiveTables() {
  useLayoutEffect(() => {
    const root = document.querySelector('.app-shell')
    if (!root) return
    const tracked = new Map<HTMLTableElement, HTMLElement>()
    const observedWidths = new WeakMap<Element, number>()
    const update = () => {
      for (const [table, parent] of tracked) if (!root.contains(table)) { resize.unobserve(parent); tracked.delete(table) }
      root.querySelectorAll<HTMLTableElement>('table').forEach(table => {
        const parent = table.parentElement
        if (!parent) return
        if (!tracked.has(table)) { tracked.set(table, parent); resize.observe(parent) }
        updateResponsiveTable(table)
        const available = observedWidths.get(parent)
        if (available !== undefined) updateScrollAccess(table, available)
      })
    }
    const resize = new ResizeObserver(entries => {
      // CSS handles width changes, including every frame of the sidebar animation.
      // Only keyboard scroll access needs updating here, not column geometry.
      for (const entry of entries) {
        observedWidths.set(entry.target, entry.contentRect.width)
        for (const child of entry.target.children) {
          if (child instanceof HTMLTableElement && tracked.has(child)) updateScrollAccess(child, entry.contentRect.width)
        }
      }
    })
    // Apply geometry in the mutation microtask, before the first painted frame.
    // Body data and navigation text cannot change declared column geometry.
    const mutation = new MutationObserver(records => {
      const structureChanged = records.some(record => {
        const target = record.target instanceof Element ? record.target : record.target.parentElement
        if (target?.closest('thead, colgroup')) return true
        return [...record.addedNodes, ...record.removedNodes].some(node =>
          node instanceof Element && (node.matches('table, thead, colgroup, col') || !!node.querySelector('table')))
      })
      if (structureChanged) update()
    })
    mutation.observe(root, { childList: true, subtree: true, characterData: true })
    update()
    return () => { mutation.disconnect(); resize.disconnect(); tracked.clear() }
  }, [])
}
