const $ = id => document.getElementById(id);
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
const state = { tables: [], selected: '', data: null, offset: 0, limit: 50, search: '', sort: '',
  direction: 'desc', filter: null, view: 'data', paused: false, connected: false, events: [],
  changed: new Map(), rows: new Map(), highlights: new Map(), identity: '', version: 0, loading: false, pending: false, totalEvents: 0 };
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
  $('connection').textContent = state.paused ? 'На паузе' : state.connected ? 'Обновление по событиям' : 'Восстанавливаем связь…';
  $('connection').classList.toggle('waiting', state.paused || !state.connected);
  $('pause').textContent = state.paused ? 'Продолжить' : 'Пауза';
}
function renderTables() {
  const search = $('table-search').value.trim().toLowerCase();
  const list = state.tables.filter(t => `${t.name} ${labels[t.name] || ''}`.toLowerCase().includes(search));
  const nodes = list.map(table => {
    const button = element('button', undefined, 'table-choice');
    button.classList.toggle('active', table.name === state.selected);
    button.classList.toggle('changed', state.changed.has(table.name));
    button.setAttribute('aria-pressed', String(table.name === state.selected));
    const title = element('span');
    title.append(element('span', table.name, 'name'));
    title.append(element('small', labels[table.name] || 'Таблица БД'));
    button.append(title, element('span', count(table.count), 'table-total'));
    button.onclick = () => selectTable(table.name);
    return button;
  });
  $('table-list').replaceChildren(...(nodes.length ? nodes : [element('p', 'Таблицы не найдены', 'muted')]));
  $('table-count').textContent = state.tables.length;
}
function selectTable(name, filter = null) {
  state.selected = name; state.filter = filter; state.offset = 0; state.search = ''; state.sort = '';
  state.data = null; state.version++;
  $('row-search').value = '';
  $('table-title').textContent = name;
  $('table-description').textContent = labels[name] || 'Таблица БД';
  $('relation-filter').hidden = !filter;
  $('filter-text').textContent = filter ? `${filter.column} = ${filter.value}` : '';
  $('data-table').replaceChildren(); $('empty').hidden = false; $('empty').textContent = 'Загружаем данные…';
  renderTables(); refresh(true);
}
function detail(row) {
  $('detail-title').textContent = state.selected;
  const list = element('dl');
  for (const [key, value] of Object.entries(row)) {
    const field = element('div', undefined, 'detail-field');
    field.append(element('dt', key), element('dd', value === null ? 'NULL' : value)); list.append(field);
  }
  $('detail-body').replaceChildren(list); $('detail').showModal();
}
function renderData() {
  const data = state.data;
  if (!data) return;
  $('table-title').textContent = data.name;
  $('rows-count').textContent = `${count(data.total)} строк${state.search || state.filter ? ' найдено' : ''}`;
  $('updated').textContent = `Обновлено ${stamp(data.at)}`;
  $('reset-sort').textContent = state.sort ? `Сортировка: ${state.sort} ${state.direction === 'asc' ? '↑' : '↓'}` : 'Последние изменения ↓';
  $('data-tab').setAttribute('aria-selected', String(state.view === 'data'));
  $('schema-tab').setAttribute('aria-selected', String(state.view === 'schema'));
  $('previous').disabled = state.offset === 0;
  $('next').disabled = state.offset + state.limit >= Number(data.total);
  $('page-info').textContent = Number(data.total) ? `${state.offset + 1}–${Math.min(state.offset + data.rows.length, Number(data.total))} из ${count(data.total)}` : '0 строк';
  const head = element('thead'), body = element('tbody'), heading = element('tr');
  head.append(heading);
  if (state.view === 'schema') {
    for (const title of ['Колонка', 'Тип данных', 'NULL', 'Ключ', 'Связь']) heading.append(element('th', title));
    for (const column of data.columns) {
      const row = element('tr');
      const relation = data.relations.find(r => r.column === column.name);
      for (const text of [column.name, column.type, column.nullable ? 'Да' : 'Нет', column.primary ? 'PRIMARY KEY' : '', relation ? `${relation.target}.${relation.target_column}` : '—']) row.append(element('td', text));
      body.append(row);
    }
    $('empty').hidden = true;
  } else {
    heading.append(element('th', ''));
    for (const column of data.columns) {
      const th = element('th');
      const button = element('button', `${column.primary ? '◇ ' : ''}${column.name}${state.sort === column.name ? (state.direction === 'asc' ? ' ↑' : ' ↓') : ''}`);
      button.onclick = () => { state.direction = state.sort === column.name && state.direction === 'asc' ? 'desc' : 'asc'; state.sort = column.name; state.offset = 0; state.version++; refresh(true); };
      th.append(button, element('span', column.type, 'type')); heading.append(th);
    }
    const keys = data.columns.filter(c => c.primary).map(c => c.name);
    const identity = JSON.stringify([data.name, state.offset, state.limit, state.search, state.sort, state.direction, state.filter]);
    const comparable = identity === state.identity;
    if (!comparable) state.highlights.clear();
    const nextRows = new Map();
    for (const record of data.rows) {
      const row = element('tr');
      const key = JSON.stringify(keys.length ? keys.map(k => record[k]) : record);
      const serialized = JSON.stringify(record);
      nextRows.set(key, serialized);
      if (comparable && !state.rows.has(key)) state.highlights.set(key, { kind: 'new', until: Date.now() + 8000 });
      else if (comparable && state.rows.get(key) !== serialized) state.highlights.set(key, { kind: 'modified', until: Date.now() + 8000 });
      const highlight = state.highlights.get(key);
      if (highlight?.until > Date.now()) row.classList.add(highlight.kind);
      else state.highlights.delete(key);
      const action = element('td', undefined, 'action-cell');
      const open = element('button', '↗', 'row-open'); open.title = 'Открыть все поля записи'; open.setAttribute('aria-label', 'Открыть запись'); open.onclick = () => detail(record); action.append(open); row.append(action);
      for (const column of data.columns) {
        const value = record[column.name];
        const td = element('td', undefined, value === null ? 'null' : '');
        const relation = data.relations.find(r => r.column === column.name);
        const target = relation?.target.replace(/^public\./, '');
        if (value !== null && relation && state.tables.some(t => t.name === target)) {
          const link = element('button', value, 'fk'); link.title = `Открыть ${target}: ${value}`;
          link.onclick = () => selectTable(target, { column: relation.target_column, value }); td.append(link);
        } else td.textContent = value === null ? 'NULL' : value === '' ? '""' : value;
        td.title = value === null ? 'NULL' : value; row.append(td);
      }
      body.append(row);
    }
    state.rows = nextRows; state.identity = identity;
    $('empty').hidden = data.rows.length > 0;
    $('empty').textContent = state.search || state.filter ? 'Нет записей по заданному условию.' : 'В таблице пока нет записей. Новые появятся автоматически.';
  }
  $('data-table').replaceChildren(head, body);
}
async function refresh(force = false) {
  if (state.paused && !force) return;
  if (state.loading) { state.pending = true; return; }
  state.loading = true;
  const version = state.version;
  try {
    const overview = await get('/api/tables');
    state.tables = overview.tables;
    $('database').textContent = `${overview.database} / ${overview.schema} · PostgreSQL`;
    const missing = overview.tables.filter(t => !t.observed);
    $('observer-warning').hidden = missing.length === 0;
    $('observer-warning').textContent = `Для ${missing.length} таблиц не включены уведомления. Повторно установите наблюдатель по инструкции в database/README.md.`;
    if (!state.selected && overview.tables.length) {
      state.selected = overview.tables.some(t => t.name === 'receiving_order') ? 'receiving_order' : overview.tables[0].name;
      $('table-description').textContent = labels[state.selected] || 'Таблица БД';
    }
    renderTables();
    if (state.selected) {
      const params = new URLSearchParams({ name: state.selected, offset: state.offset, limit: state.limit, search: state.search, sort: state.sort, direction: state.direction });
      if (state.filter) { params.set('column', state.filter.column); params.set('value', state.filter.value); }
      const data = await get(`/api/table?${params}`);
      if (version === state.version) {
        if (Number(data.total) > 0 && state.offset >= Number(data.total)) { state.offset = 0; state.version++; state.pending = true; }
        else { state.data = data; renderData(); }
      } else state.pending = true;
    }
    showError('');
  } catch (error) { showError(error.message === 'The operation was aborted due to timeout' ? 'БД не ответила вовремя. Нажмите «Обновить».' : error.message); }
  finally {
    state.loading = false;
    if (state.pending) { state.pending = false; refresh(force); }
  }
}
function renderEvents() {
  $('event-count').textContent = count(state.totalEvents);
  const operations = { INSERT: 'Добавление', UPDATE: 'Изменение', DELETE: 'Удаление', TRUNCATE: 'Очистка' };
  const nodes = state.events.map(event => {
    const button = element('button', undefined, `event ${event.operation}`);
    button.append(element('time', stamp(event.at)), element('span', operations[event.operation] || event.operation, 'operation'), element('span', event.table, 'event-table'), element('span', `Транзакция ${event.transaction}`, 'tx'));
    button.onclick = () => selectTable(event.table);
    return button;
  });
  $('activity').replaceChildren(...(nodes.length ? nodes : [element('div', 'Ожидаем изменения. Создайте или измените документ в MVP.', 'activity-empty')]));
}
const source = new EventSource('/api/events');
source.addEventListener('status', event => {
  state.connected = JSON.parse(event.data).connected; connectionStatus();
  if (state.connected) refresh();
});
source.addEventListener('change', event => {
  const change = JSON.parse(event.data);
  state.totalEvents++; state.events.unshift(change); state.events.length = Math.min(state.events.length, 100);
  state.changed.set(change.table, change.at);
  if (!state.paused) { renderEvents(); refresh(); }
});
source.onerror = () => { state.connected = false; connectionStatus(); };
$('table-search').oninput = renderTables;
let searchTimer;
$('row-search').oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { state.search = $('row-search').value; state.offset = 0; state.version++; refresh(true); }, 250); };
$('pause').onclick = () => { state.paused = !state.paused; connectionStatus(); if (!state.paused) { renderEvents(); refresh(true); } };
$('refresh').onclick = () => refresh(true);
$('page-size').onchange = () => { state.limit = Number($('page-size').value); state.offset = 0; state.version++; refresh(true); };
$('previous').onclick = () => { state.offset = Math.max(0, state.offset - state.limit); state.version++; refresh(true); };
$('next').onclick = () => { state.offset += state.limit; state.version++; refresh(true); };
$('reset-sort').onclick = () => { state.sort = ''; state.offset = 0; state.version++; refresh(true); };
$('clear-filter').onclick = () => selectTable(state.selected);
$('data-tab').onclick = () => { state.view = 'data'; renderData(); };
$('schema-tab').onclick = () => { state.view = 'schema'; renderData(); };
$('close-detail').onclick = () => $('detail').close();
$('clear-events').onclick = () => { state.events = []; state.totalEvents = 0; state.changed.clear(); renderEvents(); renderTables(); };
refresh();
