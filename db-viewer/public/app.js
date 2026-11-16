const $ = id => document.getElementById(id);
const global$ = $;
const labels = {
  receiving_order: 'Заявки на поставку', shipping_order: 'Заявки на вывоз',
  comprehensive_service_order: 'Комплексные услуги', route: 'Рейсы',
  waybill: 'Накладные', waybill_container: 'КТК накладных', waybill_railway_carriage: 'Вагоны накладных',
  container: 'Справочник КТК', container_owner: 'Остатки и собственники',
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

function addPanel() {
  const panel = createPanel(nextPanel++);
  panels.push(panel);
  $('panels').append(panel.root);
  activate(panel); layoutPanels();
  panel.options();
  if (app.tables.length) {
    const name = app.tables.find(table => !panels.some(item => item.state.selected === table.name))?.name || app.tables[0].name;
    panel.select(name);
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
  function selectTable(name, filter = null) {
    clearTimeout(searchTimer);
    state.selected = name; state.filter = filter; state.offset = 0; state.search = ''; state.sort = '';
    state.data = null; state.version++;
    $('row-search').value = '';
    $('table-select').value = name;
    showPanelError('');
    $('table-title').textContent = name;
    $('table-description').textContent = labels[name] || 'Таблица БД';
    $('relation-filter').hidden = !filter;
    $('filter-text').textContent = filter ? `${filter.column} = ${filter.value}` : '';
    $('data-table').replaceChildren(); $('empty').hidden = false; $('empty').textContent = 'Загружаем данные…';
    renderTables(); refreshPanel(true);
  }

  function renderData() {
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
      if (!comparable) state.highlights.clear();
      const nextRows = new Map();
      for (const [index, record] of data.rows.entries()) {
        const row = element('tr');
        const key = JSON.stringify(keys.length ? keys.map(k => record[k]) : record);
        const serialized = JSON.stringify(record);
        nextRows.set(key, serialized);
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
          if (value !== null && relation && app.tables.some(t => t.name === target)) {
            const link = element('button', value, 'fk'); link.title = `Открыть ${target}: ${value}`;
            link.onclick = () => selectTable(target, { column: relation.target_column, value }); td.append(link);
          } else td.textContent = value === null ? 'NULL' : value === '' ? '""' : value;
          td.title = (changed ? 'Изменённое поле: ' : '') + (value === null ? 'NULL' : value); row.append(td);
        }
        body.append(row);
      }
      state.rows = nextRows; state.identity = identity;
      $('empty').hidden = data.rows.length > 0;
      $('empty').textContent = state.search || state.filter ? 'Нет записей по заданному условию.' : 'В таблице пока нет записей. Новые появятся автоматически.';
    }
    $('data-table').replaceChildren(head, body);
  }

  async function refreshPanel(force = false) {
    if (disposed || !state.selected || (app.paused && !force)) return;
    if (state.loading) { state.pending = true; return; }
    state.loading = true;
    const version = state.version;
    try {
      const params = new URLSearchParams({ name: state.selected, offset: state.offset, limit: state.limit, search: state.search, sort: state.sort, direction: state.direction });
      if (state.filter) { params.set('column', state.filter.column); params.set('value', state.filter.value); }
      const data = await get('/api/table?' + params);
      if (disposed) return;
      if (version === state.version) {
        if (Number(data.total) > 0 && state.offset >= Number(data.total)) { state.offset = 0; state.version++; state.pending = true; }
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
$('add-panel').onclick = addPanel;
$('reset-heights').onclick = resetPanelHeights;
$('pause').onclick = () => { app.paused = !app.paused; connectionStatus(); if (!app.paused) { renderEvents(); refresh(true); } };
$('refresh').onclick = () => refresh(true);
$('close-detail').onclick = () => $('detail').close();
$('clear-events').onclick = () => { app.events = []; app.totalEvents = 0; app.changed.clear(); renderEvents(); renderTables(); };
addPanel();
refresh();
