const byId = id => document.getElementById(id);
const dialog = byId('er-dialog');
const viewport = byId('er-viewport');
const graph = byId('er-graph');
const scope = byId('er-scope');
const fields = byId('er-fields');
const edgeSelect = byId('er-edge');
const mapping = byId('er-mapping');
const headerHeight = 36, rowHeight = 23;
let catalog, layout, relations, zoom, fitMode, requestVersion = 0;

function svg(tag, attributes, text) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  if (text !== undefined) node.textContent = text;
  return node;
}

function changeScope(name) {
  scope.value = name;
  fields.value = name ? 'keys' : 'none';
  render();
}

export async function openDiagram(table, get) {
  const version = ++requestVersion;
  byId('er-workspace').hidden = true;
  byId('er-status').hidden = false;
  byId('er-status').textContent = 'Загружаем схему PostgreSQL…';
  dialog.showModal();
  try {
    const data = await get('/api/diagram');
    if (version !== requestVersion || !dialog.open) return;
    catalog = data;
    scope.replaceChildren(new Option('Вся схема public', ''), ...data.tables.map(t => new Option(t.name, t.name)));
    if (!data.tables.length) {
      byId('er-status').textContent = 'В схеме public нет таблиц.';
      return;
    }
    byId('er-status').hidden = true;
    byId('er-workspace').hidden = false;
    changeScope(data.tables.some(t => t.name === table) ? table : '');
    scope.focus();
  } catch (error) {
    if (version !== requestVersion || !dialog.open) return;
    byId('er-workspace').hidden = true;
    byId('er-status').hidden = false;
    byId('er-status').textContent = 'Не удалось открыть диаграмму. ' + error.message;
  }
}

function relationText(key) {
  return key.source + ' (' + key.columns.join(', ') + ') → ' +
    key.target + ' (' + key.target_columns.join(', ') + ')';
}

function selectEdge(value) {
  edgeSelect.value = value;
  const key = value === '' ? null : relations[Number(value)];
  for (const edge of graph.querySelectorAll('.er-edge')) {
    edge.classList.toggle('selected', edge.dataset.index === value);
    edge.classList.toggle('dimmed', Boolean(key) && edge.dataset.index !== value);
  }
  for (const field of graph.querySelectorAll('.er-field')) {
    const { table, column } = field.dataset;
    field.classList.toggle('selected', Boolean(key) && (
      (key.source === table && key.columns.includes(column)) ||
      (key.target === table && key.target_columns.includes(column))));
  }
  mapping.textContent = key
    ? relationText(key) + '   ·   ' + (key.unique_source ? '0..1' : '0..N') + ' → ' + (key.optional ? '0..1' : '1')
    : relations.length ? 'Стрелка ведёт от внешнего ключа к связанной таблице.' : 'Внешних ключей между этой таблицей и таблицами схемы public нет.';
}

function tableNode(table, relatedFields, fkNames, measure) {
  const rows = table.columns.filter(col => fields.value === 'all' ||
    (fields.value === 'keys' && (col.primary || relatedFields.has(col.name))));
  const width = Math.ceil(Math.max(150, measure(table.name) + 30,
    ...rows.map(col => measure(col.name) + measure(col.type) + 90)));
  return { table, rows, fkNames, width, height: headerHeight + rows.length * rowHeight };
}

function drawTable(node) {
  const { table, rows, fkNames, width, height, x, y } = node;
  const group = svg('g', {
    class: 'er-node' + (scope.value === table.name ? ' current' : ''),
    transform: 'translate(' + (x - width / 2) + ' ' + (y - height / 2) + ')',
    role: 'button', tabindex: 0, 'aria-label': 'Связи таблицы ' + table.name,
  });
  group.append(svg('title', {}, 'Открыть связи таблицы ' + table.name),
    svg('rect', { class: 'er-card', width, height, rx: 4 }),
    svg('rect', { class: 'er-card-head', width, height: headerHeight, rx: 4 }),
    svg('text', { class: 'er-name', x: 12, y: 23 }, table.name));
  rows.forEach((col, index) => {
    const row = svg('g', { class: 'er-field', 'data-table': table.name, 'data-column': col.name });
    const top = headerHeight + index * rowHeight;
    const keys = [col.primary && 'PK', fkNames.has(col.name) && 'FK'].filter(Boolean).join('·');
    row.append(svg('rect', { x: 1, y: top, width: width - 2, height: rowHeight }),
      svg('text', { class: col.primary ? 'er-pk' : 'er-fk', x: 10, y: top + 16 }, keys),
      svg('text', { x: 51, y: top + 16 }, col.name),
      svg('text', { class: 'er-type', x: width - 11, y: top + 16, 'text-anchor': 'end' }, col.type));
    group.append(row);
  });
  const open = () => { changeScope(table.name); scope.focus(); };
  group.onclick = open;
  group.onkeydown = event => {
    if (['Enter', ' '].includes(event.key)) { event.preventDefault(); open(); }
  };
  return group;
}

// In the detailed view a line meets the first field of its key. The inspector
// and the highlighted rows show every pair of a composite constraint.
function fieldPort(node, column, neighbor, fallback) {
  const row = node.rows.findIndex(col => col.name === column);
  if (row < 0 || Math.abs(neighbor.x - node.x) < node.width / 2) return fallback;
  return { x: node.x + Math.sign(neighbor.x - node.x) * node.width / 2,
    y: node.y - node.height / 2 + headerHeight + (row + 0.5) * rowHeight };
}

function drawEdge(key, index, points) {
  const path = points.slice();
  path[0] = fieldPort(layout.node(key.source), key.columns[0], points[1], points[0]);
  path[path.length - 1] = fieldPort(layout.node(key.target), key.target_columns[0], points.at(-2), points.at(-1));
  const coordinates = path.map(p => p.x + ',' + p.y).join(' ');
  const group = svg('g', { class: 'er-edge', 'data-index': index });
  group.append(svg('title', {}, relationText(key)),
    svg('polyline', { class: 'er-line', points: coordinates, 'marker-end': 'url(#er-arrow)' }),
    svg('polyline', { class: 'er-hit', points: coordinates }));
  group.onclick = () => selectEdge(String(index));
  return group;
}

function render() {
  const selected = scope.value;
  relations = catalog.relations.filter(r => !selected || r.source === selected || r.target === selected);
  const neighbors = new Set(relations.flatMap(r => [r.source, r.target]));
  const tables = catalog.tables.filter(t => !selected || t.name === selected || neighbors.has(t.name));
  const ctx = document.createElement('canvas').getContext('2d');
  ctx.font = '13px ' + getComputedStyle(dialog).getPropertyValue('--mono');
  const measure = text => ctx.measureText(text).width;
  layout = new window.dagre.graphlib.Graph({ multigraph: true });
  layout.setGraph({ rankdir: 'LR', ranksep: selected ? 82 : 110, nodesep: 24, edgesep: 18, marginx: 22, marginy: 22 });
  for (const table of tables) {
    const fkNames = new Set(catalog.relations.filter(r => r.source === table.name).flatMap(r => r.columns));
    const relatedFields = new Set(relations.flatMap(r => [
      ...(r.source === table.name ? r.columns : []), ...(r.target === table.name ? r.target_columns : []),
    ]));
    layout.setNode(table.name, tableNode(table, relatedFields, fkNames, measure));
  }
  relations.forEach((key, index) => layout.setEdge(key.source, key.target, {}, String(index)));
  window.dagre.layout(layout);
  const { width, height } = layout.graph();
  graph.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
  byId('er-drawing').replaceChildren(
    ...relations.map((key, index) => drawEdge(key, index, layout.edge(key.source, key.target, String(index)).points)),
    ...tables.map(t => drawTable(layout.node(t.name))));
  edgeSelect.replaceChildren(new Option(relations.length ? 'Выберите связь (' + relations.length + ')' : 'Нет связей', ''),
    ...relations.map((r, i) => new Option(relationText(r), String(i))));
  edgeSelect.disabled = !relations.length;
  selectEdge('');
  const initial = fitScale();
  setScale(selected ? Math.max(0.8, initial) : initial);
  fitMode = zoom === initial;
  const center = selected && layout.node(selected);
  viewport.scrollTo(center ? center.x * zoom - viewport.clientWidth / 2 : 0,
    center ? center.y * zoom - viewport.clientHeight / 2 : 0);
}

function fitScale() {
  const { width, height } = layout.graph();
  return Math.min(1, (viewport.clientWidth - 14) / width, (viewport.clientHeight - 14) / height);
}

function setScale(value) {
  const { width, height } = layout.graph();
  zoom = Math.min(2.5, Math.max(0.02, value));
  graph.setAttribute('width', Math.ceil(width * zoom));
  graph.setAttribute('height', Math.ceil(height * zoom));
  byId('er-scale').textContent = Math.round(zoom * 100) + '%';
  byId('er-plus').disabled = zoom >= 2.5;
  byId('er-minus').disabled = zoom <= 0.02;
}

function stepZoom(factor) {
  const old = graph.getBoundingClientRect(), box = viewport.getBoundingClientRect();
  const cx = (box.left + viewport.clientWidth / 2 - old.left) / old.width;
  const cy = (box.top + viewport.clientHeight / 2 - old.top) / old.height;
  fitMode = false;
  setScale(zoom * factor);
  viewport.scrollTo(cx * graph.clientWidth - viewport.clientWidth / 2, cy * graph.clientHeight - viewport.clientHeight / 2);
}

let drag;
viewport.onpointerdown = event => {
  if (event.pointerType !== 'mouse' || event.button !== 0 || event.target.closest('.er-node,.er-edge')) return;
  drag = { x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop };
  viewport.setPointerCapture(event.pointerId);
  viewport.classList.add('dragging');
};
viewport.onpointermove = event => {
  if (drag) viewport.scrollTo(drag.left + drag.x - event.clientX, drag.top + drag.y - event.clientY);
};
viewport.onlostpointercapture = () => { drag = null; viewport.classList.remove('dragging'); };
scope.onchange = () => changeScope(scope.value);
fields.onchange = render;
edgeSelect.onchange = () => selectEdge(edgeSelect.value);
byId('er-fit').onclick = () => { fitMode = true; setScale(fitScale()); };
byId('er-plus').onclick = () => stepZoom(1.35);
byId('er-minus').onclick = () => stepZoom(1 / 1.35);
byId('er-close').onclick = () => dialog.close();
new ResizeObserver(() => {
  if (dialog.open && fitMode && viewport.clientWidth && viewport.clientHeight) setScale(fitScale());
}).observe(viewport);
