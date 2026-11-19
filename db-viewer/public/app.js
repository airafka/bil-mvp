const $ = id => document.getElementById(id);
const global$ = $;
const labels = {
  receiving_order: 'Заявки на поставку', shipping_order: 'Заявки на вывоз',
  comprehensive_service_order: 'Комплексные услуги', route: 'Рейсы',
  waybill: 'Накладные', waybill_container: 'КТК накладных', waybill_railway_carriage: 'Вагоны накладных',
  container: 'Справочник КТК', container_owner: 'Складское состояние КТК', container_visit: 'Визиты receiving → shipping', container_ownership_period: 'Периоды собственников',
  container_owner_history: 'История КТК', container_movement: 'Движения КТК',
  container_storage_period: 'Периоды хранения', container_stock_reservation: 'Резервы КТК',
  shipping_order_container: 'КТК вывоза', receiving_order_container: 'КТК автопоставки',
  billing_charge: 'Начисления', service_execution: 'Оказанные услуги',
  payment_invoice: 'Счета на оплату', payment_invoice_line: 'Строки счетов',
  client: 'Клиенты', contract: 'Договоры', complex_service_catalog: 'Каталог услуг',
  complex_service_tariff: 'Тарифы', order_cancellation: 'Отмены заявок',
  service_order: 'Смена собственника', railway_carriage: 'Вагоны',
};

const app = { tables: [], paused: false, connected: false, events: [], changed: new Map(), totalEvents: 0, loading: false, pending: false };
const panels = [];
let active;
let nextPanel = 1;
const stamp = date => new Date(date).toLocaleTimeString('ru-RU', { hour12: false });
const count = value => Number(value).toLocaleString('ru-RU');
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function showError(message) { $('error').textContent = message; $('error').hidden = !message; }
async function get(path) {
  const response = await fetch(path, { signal: AbortSignal.timeout(12000) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Не удалось получить данные');
  return data;
}

function connectionStatus() {
  $('connection').textContent = app.paused ? 'На паузе' : app.connected ? 'Обновление по событиям' : 'Восстанавливаем связь…';
  $('connection').classList.toggle('waiting', app.paused || !app.connected);
  $('pause').textContent = app.paused ? 'Продолжить' : 'Пауза';
}

function renderTables() {
  const search = $('table-search').value.trim().toLowerCase();
  const list = app.tables.filter(t => `${t.name} ${labels[t.name] || ''}`.toLowerCase().includes(search));
  const nodes = list.map(table => {
    const button = element('button', undefined, 'table-choice');
    button.classList.toggle('active', table.name === active?.state.selected);
    button.classList.toggle('changed', app.changed.has(table.name));
    button.setAttribute('aria-pressed', String(table.name === active?.state.selected));
    button.title = `${table.name} — ${labels[table.name] || 'Таблица БД'}`;
    const title = element('span');
    title.append(element('span', table.name, 'name'));
    title.append(element('small', labels[table.name] || 'Таблица БД'));
    button.append(title, element('span', count(table.count), 'table-total'));
    button.onclick = () => active?.select(table.name);
    return button;
  });
  $('table-list').replaceChildren(...(nodes.length ? nodes : [element('p', 'Таблицы не найдены', 'muted')]));
  $('table-count').textContent = app.tables.length;
}

function detail(row, name) {
  $('detail-title').textContent = name;
  const list = element('dl');
  for (const [key, value] of Object.entries(row)) {
    const field = element('div', undefined, 'detail-field');
    field.append(element('dt', key), element('dd', value === null ? 'NULL' : value)); list.append(field);
  }
  $('detail-body').replaceChildren(list); $('detail').showModal();
}

function activate(panel) {
  if (active === panel) return;
  active = panel;
  for (const item of panels) {
    item.root.classList.toggle('active-pane', item === panel);
    item.root.querySelector('[data-role="activate"]').setAttribute('aria-pressed', String(item === panel));
  }
  $('navigator-target').textContent = 'Выбор для панели ' + panel.number;
  renderTables();
}
let finishPanelResize;
const minimumPanelHeight = () => window.innerWidth <= 700 ? 360 : 280;
function updatePanelHeights() {
  const minimum = minimumPanelHeight();
  const tracks = [];
  for (const [index, panel] of panels.entries()) {
    if (panel.height !== undefined) panel.height = Math.max(minimum, panel.height);
    tracks.push(panel.height === undefined ? (window.innerWidth <= 700 ? '520px' : 'minmax(320px,1fr)') : panel.height + 'px');
    if (index < panels.length - 1) tracks.push('14px');
  }
  $('panels').style.gridTemplateRows = panels.length > 1 ? tracks.join(' ') : '';
  for (const handle of $('panels').querySelectorAll('.panel-resize')) {
    const above = handle.previousElementSibling.getBoundingClientRect().height;
    const below = handle.nextElementSibling.getBoundingClientRect().height;
    handle.setAttribute('aria-valuemin', String(minimum));
    handle.setAttribute('aria-valuemax', String(Math.max(minimum, Math.round(above + below - minimum))));
    handle.setAttribute('aria-valuenow', String(Math.round(above)));
    handle.setAttribute('aria-valuetext', 'Высота верхней панели: ' + Math.round(above) + ' пикселей');
  }
}
function resetPanelHeights() {
  finishPanelResize?.();
  for (const panel of panels) delete panel.height;
  updatePanelHeights();
}
function freezePanelHeights() {
  for (const panel of panels) panel.height = panel.root.getBoundingClientRect().height;
}
function resizePanelPair(above, below, height, total) {
  const minimum = minimumPanelHeight();
  above.height = Math.max(minimum, Math.min(total - minimum, height));
  below.height = total - above.height;
  updatePanelHeights();
}
function createPanelResize(above, below) {
  const handle = element('div', undefined, 'panel-resize');
  handle.tabIndex = 0;
  handle.setAttribute('role', 'separator');
  handle.setAttribute('aria-orientation', 'horizontal');
  handle.setAttribute('aria-controls', above.root.id + ' ' + below.root.id);
  handle.setAttribute('aria-label', 'Изменить высоту панелей ' + above.number + ' и ' + below.number);
  handle.title = 'Потяните вверх или вниз. Стрелки ↑/↓ — изменить высоту, двойной щелчок — выровнять панели.';
  let drag;
  function finish() {
    if (!drag) return;
    const pointerId = drag.pointerId;
    drag = undefined;
    document.body.classList.remove('resizing-panels');
    if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
    if (finishPanelResize === finish) finishPanelResize = undefined;
  }
  handle.onpointerdown = event => {
    if (event.button !== 0) return;
    finishPanelResize?.();
    event.preventDefault();
    freezePanelHeights();
    drag = { pointerId: event.pointerId, y: event.clientY, height: above.height, total: above.height + below.height };
    handle.setPointerCapture(event.pointerId);
    handle.focus({ preventScroll: true });
    document.body.classList.add('resizing-panels');
    finishPanelResize = finish;
    updatePanelHeights();
  };
  handle.onpointermove = event => {
    if (drag && drag.pointerId === event.pointerId) resizePanelPair(above, below, drag.height + event.clientY - drag.y, drag.total);
  };
  handle.onpointerup = finish;
  handle.onpointercancel = finish;
  handle.onlostpointercapture = finish;
  handle.ondblclick = resetPanelHeights;
  handle.onkeydown = event => {
    if (event.key === 'Escape' && drag) {
      event.preventDefault();
      resizePanelPair(above, below, drag.height, drag.total);
      finish(); return;
    }
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    finishPanelResize?.();
    freezePanelHeights();
    const total = above.height + below.height;
    const step = event.shiftKey ? 80 : 20;
    const height = event.key === 'Home' ? minimumPanelHeight() : event.key === 'End' ? total - minimumPanelHeight()
      : above.height + (event.key === 'ArrowUp' ? -step : step);
    resizePanelPair(above, below, height, total);
  };
  return handle;
}
window.addEventListener('resize', () => { finishPanelResize?.(); updatePanelHeights(); });
window.addEventListener('blur', () => finishPanelResize?.());
function layoutPanels() {
  finishPanelResize?.();
  $('panels').classList.toggle('multiple', panels.length > 1);
  $('panels').classList.toggle('many', panels.length > 2);
  $('reset-heights').hidden = panels.length < 2;
  for (const handle of $('panels').querySelectorAll('.panel-resize')) handle.remove();
  for (const [index, panel] of panels.entries()) {
    panel.root.querySelector('[data-role="close"]').disabled = panels.length === 1;
    if (panels.length === 1) delete panel.height;
    if (index < panels.length - 1) $('panels').insertBefore(createPanelResize(panel, panels[index + 1]), panels[index + 1].root);
  }
  updatePanelHeights();
}

function addPanel({ after = null, table = null, filter = null } = {}) {
  const panel = createPanel(nextPanel++);
  const index = after ? panels.indexOf(after) + 1 : panels.length;
  $('panels').insertBefore(panel.root, panels[index]?.root || null);
  panels.splice(index, 0, panel);
  activate(panel); layoutPanels();
  panel.options();
  if (app.tables.length) {
    const name = table || app.tables.find(item => !panels.some(p => p.state.selected === item.name))?.name || app.tables[0].name;
    panel.select(name, filter);
  }
  panel.root.querySelector('[data-role="table-select"]').focus();
  return panel;
}
function createPanel(number) {
  const root = global$('panel-template').content.firstElementChild.cloneNode(true);
  const $ = role => root.querySelector('[data-role="' + role + '"]');
  const state = { selected: '', data: null, offset: 0, limit: 50, search: '', sort: '', direction: 'desc', filter: null, view: 'data', rows: new Map(), highlights: new Map(), identity: '', version: 0, loading: false, pending: false };
  let disposed = false;
  let optionsKey = '';
  let searchTimer;
  const backHistory = [], forwardHistory = [];
  let pendingScroll = null;
  const columnWidths = new Map();
  let finishColumnResize;
  const cancelColumnResize = () => finishColumnResize?.(true);
  window.addEventListener('blur', cancelColumnResize);
  const panel = { root, number, state, select: selectTable, refresh: refreshPanel, options: updateOptions };
  root.id = 'table-panel-' + number;
  root.setAttribute('aria-label', 'Панель ' + number);
  $('table-select').setAttribute('aria-label', 'Таблица панели ' + number);
  $('close').setAttribute('aria-label', 'Закрыть панель ' + number);
  $('activate').textContent = 'Панель ' + number;
  root.addEventListener('pointerdown', () => activate(panel));
  root.addEventListener('focusin', () => activate(panel));
  $('activate').onclick = () => activate(panel);
  $('table-select').onchange = () => selectTable($('table-select').value);
  $('close').onclick = () => {
    if (panels.length === 1) return;
    disposed = true; clearTimeout(searchTimer);
    cancelColumnResize(); window.removeEventListener('blur', cancelColumnResize);
    const index = panels.indexOf(panel);
    panels.splice(index, 1); root.remove();
    if (active === panel) activate(panels[Math.min(index, panels.length - 1)]);
    layoutPanels();
    active.root.querySelector('[data-role="activate"]').focus();
  };
  function updateOptions() {
    const key = JSON.stringify(app.tables.map(table => table.name));
    if (key === optionsKey) return;
    optionsKey = key;
    const options = app.tables.map(table => {
      const option = element('option', table.name + (labels[table.name] ? ' — ' + labels[table.name] : ''));
      option.value = table.name; return option;
    });
    $('table-select').replaceChildren(...options);
    $('table-select').value = state.selected;
  }
  function showPanelError(message) { $('error').textContent = message; $('error').hidden = !message; }
  function captureLocation() {
    const search = $('row-search').value;
    return { selected: state.selected, filter: state.filter ? { ...state.filter } : null,
      offset: search === state.search ? state.offset : 0, limit: state.limit, search,
      sort: state.sort, direction: state.direction, view: state.view,
      scrollTop: $('data-scroll').scrollTop, scrollLeft: $('data-scroll').scrollLeft };
  }
  function updateHistoryButtons() {
    $('history-back').disabled = backHistory.length === 0;
    $('history-forward').disabled = forwardHistory.length === 0;
    $('history-back').title = backHistory.length ? 'Назад: ' + backHistory.at(-1).selected : 'Нет предыдущей таблицы';
    $('history-forward').title = forwardHistory.length ? 'Вперёд: ' + forwardHistory.at(-1).selected : 'Нет следующей таблицы';
  }
  function openLocation(location) {
    cancelColumnResize();
    clearTimeout(searchTimer);
    const { scrollTop, scrollLeft, ...selection } = location;
    Object.assign(state, selection);
    pendingScroll = { top: scrollTop, left: scrollLeft };
    state.data = null; state.version++;
    state.rows.clear(); state.highlights.clear(); state.identity = '';
    $('row-search').value = state.search;
    $('page-size').value = String(state.limit);
    $('table-select').value = state.selected;
    showPanelError('');
    $('table-title').textContent = state.selected;
    $('table-description').textContent = labels[state.selected] || 'Таблица БД';
    $('relation-filter').hidden = !state.filter;
    $('filter-text').textContent = state.filter ? (state.filter.conditions || [state.filter]).map(condition => condition.column + ' = ' + condition.value).join(' · ') : '';
    $('data-table').replaceChildren(); $('empty').hidden = false; $('empty').textContent = 'Загружаем данные…';
    updateHistoryButtons(); renderTables(); refreshPanel(true);
  }
  function selectTable(name, filter = null) {
    const current = captureLocation();
    const destination = { selected: name, filter: filter ? { ...filter } : null,
      offset: 0, limit: state.limit, search: '', sort: '', direction: 'desc', view: state.view,
      scrollTop: 0, scrollLeft: 0 };
    if (state.selected && JSON.stringify(current) !== JSON.stringify(destination)) {
      backHistory.push(current);
      forwardHistory.length = 0;
    }
    openLocation(destination);
  }
  function travelHistory(from, to) {
    if (!from.length) return;
    to.push(captureLocation());
    openLocation(from.pop());
  }
  $('history-back').onclick = () => travelHistory(backHistory, forwardHistory);
  $('history-forward').onclick = () => travelHistory(forwardHistory, backHistory);
  updateHistoryButtons();

  function configureColumns(heading, data) {
    const table = $('data-table');
    table.classList.add('column-grid');
    // Measure the actual header font, icon, sort arrow and padding before sizing the grid.
    const probe = element('table', undefined, 'column-grid column-measure');
    probe.setAttribute('aria-hidden', 'true');
    const probeHead = element('thead'), probeRow = heading.cloneNode(true);
    if (state.view === 'data') {
      for (const [index, th] of [...probeRow.children].entries()) {
        const button = th.querySelector('button');
        if (button) button.lastChild.textContent = '↑ ' + data.columns[index - 1].name;
      }
    }
    probeHead.append(probeRow); probe.append(probeHead); root.append(probe);
    const minimums = [...probeRow.children].map((th, index) => state.view === 'data' && index === 0
      ? 42 : Math.max(64, Math.ceil(th.getBoundingClientRect().width) + 1));
    probe.remove();
    const defaults = (state.view === 'schema'
      ? [200, 420, 160, 80, 150, 240]
      : [42, ...data.columns.map(column => column.type === 'uuid' ? 0
        : Math.min(280, Math.max(column.type.includes('timestamp') ? 210 : 130, column.name.length * 8 + 42)))]).map((width, index) => Math.max(width, minimums[index]));
    const names = state.view === 'schema' ? ['Колонка', 'Примечание', 'Тип данных', 'NULL', 'Ключ', 'Связь']
      : ['#', ...data.columns.map(column => column.name)];
    const keys = names.map(name => JSON.stringify([data.name, state.view, name]));
    const widths = defaults.map((width, index) => Math.max(minimums[index], columnWidths.get(keys[index]) ?? width));
    const group = element('colgroup');
    const columns = widths.map(width => { const col = element('col'); col.style.width = width + 'px'; group.append(col); return col; });
    const totalWidth = () => { table.style.width = widths.reduce((sum, width) => sum + width, 0) + 'px'; };
    totalWidth();
    for (const [index, th] of [...heading.children].entries()) {
      th.title = names[index];
      if (state.view === 'data' && index === 0) continue;
      const handle = element('span', undefined, 'column-resize');
      handle.tabIndex = 0;
      handle.setAttribute('role', 'separator');
      handle.setAttribute('aria-orientation', 'vertical');
      handle.setAttribute('aria-label', 'Ширина столбца ' + names[index]);
      handle.setAttribute('aria-valuemin', String(minimums[index])); handle.setAttribute('aria-valuemax', '1200');
      handle.setAttribute('aria-valuenow', String(widths[index]));
      handle.title = 'Потяните границу столбца. Двойной щелчок — исходная ширина.';
      const apply = width => {
        widths[index] = Math.round(Math.max(minimums[index], Math.min(1200, width)));
        columnWidths.set(keys[index], widths[index]);
        columns[index].style.width = widths[index] + 'px';
        handle.setAttribute('aria-valuenow', String(widths[index])); totalWidth();
      };
      let drag;
      handle.onpointerdown = event => {
        if (event.button !== 0) return;
        cancelColumnResize(); event.preventDefault(); event.stopPropagation(); handle.focus();
        drag = { id: event.pointerId, x: event.clientX, width: widths[index], saved: columnWidths.get(keys[index]) };
        handle.setPointerCapture(event.pointerId); document.body.classList.add('resizing-columns');
        finishColumnResize = (cancel = false) => {
          const previous = drag; drag = null; finishColumnResize = null;
          if (cancel) {
            apply(previous.width);
            if (previous.saved === undefined) columnWidths.delete(keys[index]);
            else columnWidths.set(keys[index], previous.saved);
          }
          if (handle.hasPointerCapture(previous.id)) handle.releasePointerCapture(previous.id);
          document.body.classList.remove('resizing-columns');
          queueMicrotask(() => {
            if (state.pending && !state.loading && !disposed) { state.pending = false; refreshPanel(true); }
          });
        };
      };
      handle.onpointermove = event => { if (drag && drag.id === event.pointerId) apply(drag.width + event.clientX - drag.x); };
      handle.onpointerup = () => { if (drag) finishColumnResize?.(); };
      handle.onpointercancel = handle.onlostpointercapture = () => { if (drag) cancelColumnResize(); };
      handle.onclick = event => event.stopPropagation();
      handle.ondblclick = event => { event.stopPropagation(); cancelColumnResize(); apply(defaults[index]); columnWidths.delete(keys[index]); };
      handle.onkeydown = event => {
        if (event.key === 'Escape') { cancelColumnResize(); return; }
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation(); cancelColumnResize();
        const step = event.shiftKey ? 40 : 10;
        apply(event.key === 'Home' ? minimums[index] : event.key === 'End' ? 1200 : widths[index] + (event.key === 'ArrowLeft' ? -step : step));
      };
      th.append(handle);
    }
    return group;
  }

  function renderData() {
    cancelColumnResize();
    const data = state.data;
    if (!data) return;
    $('table-title').textContent = data.name;
    $('rows-count').textContent = `${count(data.total)} строк${state.search || state.filter ? ' найдено' : ''}`;
    global$('updated').textContent = `Обновлено ${stamp(data.at)}`;
    $('reset-sort').textContent = state.sort ? `Сортировка: ${state.sort} ${state.direction === 'asc' ? '↑' : '↓'}` : 'Последние изменения ↓';
    $('data-tab').setAttribute('aria-selected', String(state.view === 'data'));
    $('schema-tab').setAttribute('aria-selected', String(state.view === 'schema'));
    $('previous').disabled = state.offset === 0;
    $('next').disabled = state.offset + state.limit >= Number(data.total);
    $('page-info').textContent = Number(data.total) ? `${state.offset + 1}–${Math.min(state.offset + data.rows.length, Number(data.total))} из ${count(data.total)}` : '0 строк';
    const head = element('thead'), body = element('tbody'), heading = element('tr');
    head.append(heading);
    if (state.view === 'schema') {
      for (const title of ['Колонка', 'Примечание', 'Тип данных', 'NULL', 'Ключ', 'Связь']) heading.append(element('th', title));
      for (const column of data.columns) {
        const row = element('tr');
        const relation = data.relations.find(r => r.column === column.name);
        row.append(element('td', column.name), element('td', column.note || 'Описание назначения атрибута пока не задано.', 'schema-note'));
        for (const text of [column.type, column.nullable ? 'Да' : 'Нет', column.primary ? 'PRIMARY KEY' : '', relation ? `${relation.target}.${relation.target_column}` : '—']) row.append(element('td', text));
        body.append(row);
      }
      $('empty').hidden = true;
    } else {
      heading.append(element('th', '#', 'row-number'));
      for (const column of data.columns) {
        const th = element('th');
        const button = element('button');
        const numeric = /^(smallint|integer|bigint|numeric|real|double)/.test(column.type);
        const symbol = column.primary ? '◆' : numeric ? '123' : column.type.includes('timestamp') || column.type === 'date' ? '◷' : 'A-Z';
        const icon = element('span', symbol, `column-symbol${column.primary ? ' primary' : ''}`);
        icon.setAttribute('aria-hidden', 'true');
        button.append(icon, document.createTextNode(`${state.sort === column.name ? (state.direction === 'asc' ? '↑ ' : '↓ ') : ''}${column.name}`));
        button.onclick = () => { state.direction = state.sort === column.name && state.direction === 'asc' ? 'desc' : 'asc'; state.sort = column.name; state.offset = 0; state.version++; refreshPanel(true); };
        th.append(button); heading.append(th);
      }
      const keys = data.columns.filter(c => c.primary).map(c => c.name);
      const identity = JSON.stringify([data.name, state.offset, state.limit, state.search, state.sort, state.direction, state.filter]);
      const comparable = identity === state.identity;
      const rowKey = record => JSON.stringify(keys.length ? keys.map(k => record[k]) : record);
      const nextRows = new Map(data.rows.map(record => [rowKey(record), JSON.stringify(record)]));
      const changedSnapshot = nextRows.size !== state.rows.size ||
        [...nextRows].some(([key, value]) => state.rows.get(key) !== value);
      // A new batch replaces previous row and cell highlights, including recent inserts.
      if (!comparable || changedSnapshot) state.highlights.clear();
      for (const [index, record] of data.rows.entries()) {
        const row = element('tr');
        const key = rowKey(record);
        const serialized = nextRows.get(key);
        if (comparable && !state.rows.has(key)) state.highlights.set(key, { kind: 'new', until: Date.now() + 8000 });
        else if (comparable && state.rows.get(key) !== serialized) {
          const previous = JSON.parse(state.rows.get(key));
          const columns = data.columns.filter(column => previous[column.name] !== record[column.name]).map(column => column.name);
          state.highlights.set(key, { kind: 'modified', columns, until: Date.now() + 8000 });
        }
        const highlight = state.highlights.get(key);
        if (highlight?.until > Date.now()) row.classList.add(highlight.kind);
        else state.highlights.delete(key);
        const action = element('td', undefined, 'action-cell');
        const open = element('button', String(state.offset + index + 1), 'row-open'); open.title = 'Открыть все поля записи'; open.setAttribute('aria-label', 'Открыть запись'); open.onclick = () => detail(record, state.selected); action.append(open); row.append(action);
        for (const column of data.columns) {
          const value = record[column.name];
          const td = element('td', undefined, value === null ? 'null' : '');
          const changed = highlight?.until > Date.now() && highlight.kind === 'modified' && highlight.columns.includes(column.name);
          if (changed) td.classList.add('cell-modified');
          if (/^(smallint|integer|bigint|numeric|real|double)/.test(column.type)) td.classList.add('numeric');
          const relation = data.relations.find(r => r.column === column.name);
          const target = relation?.target.replace(/^public\./, '');
          const sourceColumns = relation?.columns || [column.name];
          if (value !== null && relation && sourceColumns.every(name => record[name] != null) && app.tables.some(t => t.name === target)) {
            const link = element('button', value, 'fk'); link.title = `Открыть ${target} в новой панели снизу: ${value}`;
            const filter = { conditions: sourceColumns.map((name, index) => ({
              column: relation.target_columns?.[index] || relation.target_column, value: record[name],
            })) };
            const openBelow = () => addPanel({ after: panel, table: target, filter });
            link.onclick = openBelow;
            td.append(link);
          } else td.textContent = value === null ? 'NULL' : value === '' ? '""' : value;
          td.title = (changed ? 'Изменённое поле: ' : '') + (value === null ? 'NULL' : value); row.append(td);
        }
        body.append(row);
      }
      state.rows = nextRows; state.identity = identity;
      $('empty').hidden = data.rows.length > 0;
      $('empty').textContent = state.search || state.filter ? 'Нет записей по заданному условию.' : 'В таблице пока нет записей. Новые появятся автоматически.';
    }
    const columnGroup = configureColumns(heading, data);
    $('data-table').replaceChildren(columnGroup, head, body);
    if (pendingScroll) {
      $('data-scroll').scrollTop = pendingScroll.top;
      $('data-scroll').scrollLeft = pendingScroll.left;
      pendingScroll = null;
    }
  }

  async function refreshPanel(force = false) {
    if (disposed || !state.selected || (app.paused && !force)) return;
    if (state.loading || finishColumnResize) { state.pending = true; return; }
    state.loading = true;
    const version = state.version;
    try {
      const params = new URLSearchParams({ name: state.selected, offset: state.offset, limit: state.limit, search: state.search, sort: state.sort, direction: state.direction });
      for (const condition of state.filter?.conditions || (state.filter ? [state.filter] : [])) {
        params.append('column', condition.column); params.append('value', condition.value);
      }
      const data = await get('/api/table?' + params);
      if (disposed) return;
      if (version === state.version) {
        if (Number(data.total) > 0 && state.offset >= Number(data.total)) { state.offset = 0; state.version++; state.pending = true; }
        else if (finishColumnResize) { state.pending = true; }
        else { state.data = data; renderData(); }
        showPanelError('');
      } else state.pending = true;
    } catch (error) {
      if (!disposed && version === state.version) showPanelError(error.message === 'The operation was aborted due to timeout' ? 'БД не ответила вовремя. Нажмите «Обновить».' : error.message);
    } finally {
      state.loading = false;
      if (state.pending && !disposed) { state.pending = false; refreshPanel(force); }
    }
  }
  $('row-search').oninput = () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.search = $('row-search').value; state.offset = 0; state.version++; refreshPanel(true); }, 250);
  };
  $('page-size').onchange = () => { state.limit = Number($('page-size').value); state.offset = 0; state.version++; refreshPanel(true); };
  $('previous').onclick = () => { state.offset = Math.max(0, state.offset - state.limit); state.version++; refreshPanel(true); };
  $('next').onclick = () => { state.offset += state.limit; state.version++; refreshPanel(true); };
  $('reset-sort').onclick = () => { state.sort = ''; state.offset = 0; state.version++; refreshPanel(true); };
  $('clear-filter').onclick = () => selectTable(state.selected);
  $('data-tab').onclick = () => { state.view = 'data'; renderData(); };
  $('schema-tab').onclick = () => { state.view = 'schema'; renderData(); };

  return panel;
}
async function refresh(force = false) {
  if (app.paused && !force) return;
  if (app.loading) { app.pending = true; return; }
  app.loading = true;
  try {
    const overview = await get('/api/tables');
    app.tables = overview.tables;
    $('database').textContent = overview.database + ' / ' + overview.schema + ' · PostgreSQL';
    $('navigator-db').textContent = overview.database;
    $('add-panel').disabled = !app.tables.length;
    const missing = app.tables.filter(table => !table.observed);
    $('observer-warning').hidden = !missing.length;
    $('observer-warning').textContent = 'Для ' + missing.length + ' таблиц не включены уведомления. Повторно установите наблюдатель по инструкции в database/README.md.';
    for (const panel of panels) {
      panel.options();
      if (!panel.state.selected && app.tables.length) panel.select(app.tables.some(table => table.name === 'receiving_order') ? 'receiving_order' : app.tables[0].name);
    }
    renderTables(); showError('');
    await Promise.all(panels.map(panel => panel.refresh(force)));
  } catch (error) { showError(error.message); }
  finally {
    app.loading = false;
    if (app.pending) { app.pending = false; refresh(force); }
  }
}
function renderEvents() {
  $('event-count').textContent = count(app.totalEvents);
  const operations = { INSERT: 'Добавление', UPDATE: 'Изменение', DELETE: 'Удаление', TRUNCATE: 'Очистка' };
  const nodes = app.events.map(event => {
    const button = element('button', undefined, `event ${event.operation}`);
    button.append(element('time', stamp(event.at)), element('span', operations[event.operation] || event.operation, 'operation'), element('span', event.table, 'event-table'), element('span', event.transaction, 'tx'));
    button.onclick = () => active?.select(event.table);
    return button;
  });
  $('activity').replaceChildren(...(nodes.length ? nodes : [element('div', 'Ожидаем изменения. Создайте или измените документ в MVP.', 'activity-empty')]));
}

const source = new EventSource('/api/events');
source.addEventListener('status', event => {
  app.connected = JSON.parse(event.data).connected; connectionStatus();
  if (app.connected) refresh();
});
source.addEventListener('change', event => {
  const change = JSON.parse(event.data);
  app.totalEvents++; app.events.unshift(change); app.events.length = Math.min(app.events.length, 100);
  app.changed.set(change.table, change.at);
  if (!app.paused) { renderEvents(); refresh(); }
});
source.onerror = () => { app.connected = false; connectionStatus(); };

const eventsVisibilityKey = 'billing-db-viewer.events-hidden';
function setEventsHidden(hidden) {
  $('activity-panel').hidden = hidden;
  $('toggle-events').textContent = hidden ? 'Показать журнал' : 'Скрыть журнал';
  $('toggle-events').setAttribute('aria-expanded', String(!hidden));
  updatePanelHeights();
}
try { setEventsHidden(localStorage.getItem(eventsVisibilityKey) === 'true'); }
catch { setEventsHidden(false); }
$('toggle-events').onclick = () => {
  const hidden = !$('activity-panel').hidden;
  setEventsHidden(hidden);
  try { localStorage.setItem(eventsVisibilityKey, String(hidden)); }
  catch { /* Keep the toggle usable when browser storage is unavailable. */ }
};
$('table-search').oninput = renderTables;
$('add-panel').onclick = () => addPanel();
$('reset-heights').onclick = resetPanelHeights;
$('pause').onclick = () => { app.paused = !app.paused; connectionStatus(); if (!app.paused) { renderEvents(); refresh(true); } };
$('refresh').onclick = () => refresh(true);
$('close-detail').onclick = () => $('detail').close();
$('clear-events').onclick = () => { app.events = []; app.totalEvents = 0; app.changed.clear(); renderEvents(); renderTables(); };
function initSidebarResize() {
  const workspace = $('viewer-workspace'), sidebar = $('database-sidebar'), handle = $('sidebar-resize');
  const storageKey = 'billing-db-viewer.navigator-width';
  let preferredWidth = null, drag = null;
  try {
    const saved = Number(localStorage.getItem(storageKey));
    if (Number.isFinite(saved) && saved > 0) preferredWidth = saved;
  } catch { /* Resizing still works if browser storage is unavailable. */ }
  const maximum = () => Math.max(180, Math.min(600, workspace.clientWidth - 430));
  const clamp = width => Math.round(Math.max(180, Math.min(maximum(), width)));
  function applyWidth() {
    if (preferredWidth === null) workspace.style.removeProperty('--navigator-width');
    else workspace.style.setProperty('--navigator-width', clamp(preferredWidth) + 'px');
    handle.setAttribute('aria-valuemin', '180');
    handle.setAttribute('aria-valuemax', String(maximum()));
    handle.setAttribute('aria-valuenow', String(Math.round(sidebar.getBoundingClientRect().width)));
    handle.setAttribute('aria-valuetext', 'Ширина меню: ' + Math.round(sidebar.getBoundingClientRect().width) + ' пикселей');
  }
  function saveWidth() {
    try {
      if (preferredWidth === null) localStorage.removeItem(storageKey);
      else localStorage.setItem(storageKey, String(preferredWidth));
    } catch { /* Keep the current width for this page. */ }
  }
  function finish(cancel = false) {
    if (!drag) return;
    const previous = drag;
    drag = null;
    if (cancel) preferredWidth = previous.preferred;
    document.body.classList.remove('resizing-sidebar');
    if (handle.hasPointerCapture(previous.id)) handle.releasePointerCapture(previous.id);
    applyWidth();
    if (!cancel) saveWidth();
  }
  handle.onpointerdown = event => {
    if (event.button !== 0 || window.innerWidth <= 700) return;
    event.preventDefault(); handle.focus();
    drag = { id: event.pointerId, x: event.clientX, width: sidebar.getBoundingClientRect().width, preferred: preferredWidth };
    handle.setPointerCapture(event.pointerId);
    document.body.classList.add('resizing-sidebar');
  };
  handle.onpointermove = event => {
    if (!drag || event.pointerId !== drag.id) return;
    preferredWidth = clamp(drag.width + event.clientX - drag.x); applyWidth();
  };
  handle.onpointerup = () => finish();
  handle.onpointercancel = () => finish(true);
  handle.onlostpointercapture = () => finish(true);
  handle.ondblclick = () => { finish(true); preferredWidth = null; applyWidth(); saveWidth(); };
  handle.onkeydown = event => {
    if (event.key === 'Escape') { finish(true); return; }
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); finish(true);
    const step = event.shiftKey ? 80 : 20;
    preferredWidth = event.key === 'Home' ? 180 : event.key === 'End' ? maximum()
      : clamp(sidebar.getBoundingClientRect().width + (event.key === 'ArrowLeft' ? -step : step));
    applyWidth(); saveWidth();
  };
  window.addEventListener('resize', () => { finish(true); applyWidth(); });
  window.addEventListener('blur', () => finish(true));
  applyWidth();
}
initSidebarResize();

addPanel();
refresh();
