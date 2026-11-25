const headerHeight = 36, rowHeight = 23;
const orderTables = new Set(['receiving_order', 'shipping_order', 'service_order']);
const orderPalette = ['#71dfac', '#ffa666', '#c69cff', '#f383b4', '#a7d768', '#ffce72',
  '#91afff', '#ff887b', '#63d9e8', '#e6adef', '#c6c977', '#76c7f3'];

// Use the whole catalog so a constraint keeps its color across panels and scopes.
export function orderHighlights(relations, visible = new Set(relations)) {
  const keys = relations.filter(key => orderTables.has(key.target))
    .sort((a, b) => a.source.localeCompare(b.source) || a.name.localeCompare(b.name));
  const colors = new Map(), fields = new Map();
  function mark(table, columns, key) {
    if (!fields.has(table)) fields.set(table, new Map());
    const byColumn = fields.get(table);
    for (const column of columns) {
      if (!byColumn.has(column)) byColumn.set(column, new Set());
      byColumn.get(column).add(key);
    }
  }
  keys.forEach((key, index) => {
    const color = orderPalette[index] ?? `hsl(${(index * 137.508) % 360} 72% 72%)`;
    colors.set(key, color);
    mark(key.source, key.columns, key);
    if (visible.has(key)) mark(key.target, key.target_columns, key);
  });
  return { colors, fields };
}

function svg(tag, attributes, text) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  if (text !== undefined) node.textContent = text;
  return node;
}

function relationText(key) {
  return key.source + ' (' + key.columns.join(', ') + ') → ' +
    key.target + ' (' + key.target_columns.join(', ') + ')';
}

// In the detailed view a line meets the first field of its key. The inspector
// and the highlighted rows show every pair of a composite constraint.
function fieldPort(node, column, neighbor, fallback) {
  const row = node.rows.findIndex(col => col.name === column);
  if (row < 0 || Math.abs(neighbor.x - node.x) < node.width / 2) return fallback;
  return { x: node.x + Math.sign(neighbor.x - node.x) * node.width / 2,
    y: node.y - node.height / 2 + headerHeight + (row + 0.5) * rowHeight };
}

export function createDiagram(root, number, get, selectTable) {
  const find = name => root.querySelector('.er-' + name);
  const viewport = find('viewport'), graph = find('graph');
  const scope = find('scope'), fields = find('fields'), edgeSelect = find('edge-picker');
  const mapping = find('mapping'), workspace = find('workspace'), status = find('status');
  const marker = find('arrow');
  marker.id = 'er-arrow-' + number;
  let catalog, highlights, home, layout, relations, zoom, fitMode, requestVersion = 0;

  function changeScope(name) {
    scope.value = name;
    fields.value = name ? 'keys' : 'none';
    render();
  }

  async function show(table) {
    const version = ++requestVersion;
    const newTable = home !== table;
    if (newTable || !catalog) {
      workspace.hidden = true;
      status.hidden = false;
      status.textContent = 'Загружаем схему PostgreSQL…';
    }
    try {
      const data = await get('/api/diagram');
      if (version !== requestVersion) return;
      if (!newTable && !workspace.hidden && JSON.stringify(catalog) === JSON.stringify(data)) return;
      catalog = data;
      home = table;
      scope.replaceChildren(new Option('Вся схема public', ''), ...data.tables.map(t => new Option(t.name, t.name)));
      if (!data.tables.length) {
        workspace.hidden = true;
        status.hidden = false;
        status.textContent = 'В схеме public нет таблиц.';
        return;
      }
      status.hidden = true;
      workspace.hidden = false;
      changeScope(data.tables.some(t => t.name === table) ? table : '');
    } catch (error) {
      if (version !== requestVersion) return;
      catalog = null;
      workspace.hidden = true;
      status.hidden = false;
      status.textContent = 'Не удалось открыть диаграмму. ' + error.message;
    }
  }

  function browse(name) {
    if (name && name !== home) selectTable(name);
    else changeScope(name);
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
    const orderFields = highlights.fields.get(table.name);
    const rows = table.columns.filter(col => fields.value === 'all' ||
      (fields.value === 'keys' && (col.primary || relatedFields.has(col.name) || orderFields?.has(col.name))));
    const width = Math.ceil(Math.max(150, measure(table.name) + 30,
      ...rows.map(col => measure(col.name) + measure(col.type) + 90)));
    return { table, rows, fkNames, orderFields, width, height: headerHeight + rows.length * rowHeight };
  }

  function drawTable(node) {
    const { table, rows, fkNames, orderFields, width, height, x, y } = node;
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
      row.append(svg('rect', { class: 'er-field-bg', x: 1, y: top, width: width - 2, height: rowHeight }),
        svg('text', { class: col.primary ? 'er-pk' : 'er-fk', x: 10, y: top + 16 }, keys),
        svg('text', { x: 51, y: top + 16 }, col.name),
        svg('text', { class: 'er-type', x: width - 11, y: top + 16, 'text-anchor': 'end' }, col.type));
      const keysHere = orderFields?.get(col.name);
      if (keysHere) {
        const bandWidth = (width - 2) / keysHere.size;
        let left = 1;
        row.prepend(svg('title', {}, [...keysHere].map(relationText).join('\n')));
        for (const key of keysHere) {
          const color = highlights.colors.get(key);
          if (keysHere.size === 1) row.style.setProperty('--er-key-color', color);
          row.append(svg('rect', { x: left, y: top + rowHeight - 3, width: bandWidth, height: 3, fill: color }));
          left += bandWidth;
        }
      }
      group.append(row);
    });
    const open = () => { browse(table.name); scope.focus(); };
    group.onclick = open;
    group.onkeydown = event => {
      if (['Enter', ' '].includes(event.key)) { event.preventDefault(); open(); }
    };
    return group;
  }

  function drawEdge(key, index, points) {
    const path = points.slice();
    path[0] = fieldPort(layout.node(key.source), key.columns[0], points[1], points[0]);
    path[path.length - 1] = fieldPort(layout.node(key.target), key.target_columns[0], points.at(-2), points.at(-1));
    const coordinates = path.map(p => p.x + ',' + p.y).join(' ');
    const group = svg('g', { class: 'er-edge', 'data-index': index });
    const color = highlights.colors.get(key);
    if (color) {
      group.classList.add('order-reference');
      group.style.setProperty('--er-key-color', color);
    }
    group.append(svg('title', {}, relationText(key)),
      svg('polyline', { class: 'er-line', points: coordinates, 'marker-end': 'url(#' + marker.id + ')' }),
      svg('polyline', { class: 'er-hit', points: coordinates }));
    group.onclick = () => selectEdge(String(index));
    return group;
  }

  function render() {
    const selected = scope.value;
    relations = catalog.relations.filter(r => !selected || r.source === selected || r.target === selected);
    highlights = orderHighlights(catalog.relations, new Set(relations));
    const neighbors = new Set(relations.flatMap(r => [r.source, r.target]));
    const tables = catalog.tables.filter(t => !selected || t.name === selected || neighbors.has(t.name));
    const ctx = document.createElement('canvas').getContext('2d');
    ctx.font = '13px ' + getComputedStyle(root).getPropertyValue('--mono');
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
    const hasOrderLinks = fields.value === 'none' ? relations.some(key => highlights.colors.has(key))
      : tables.some(t => highlights.fields.has(t.name));
    find('order-legend').hidden = !hasOrderLinks;
    find('drawing').replaceChildren(
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
    find('scale').textContent = Math.round(zoom * 100) + '%';
    find('plus').disabled = zoom >= 2.5;
    find('minus').disabled = zoom <= 0.02;
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
  scope.onchange = () => browse(scope.value);
  fields.onchange = render;
  edgeSelect.onchange = () => selectEdge(edgeSelect.value);
  find('fit').onclick = () => { fitMode = true; setScale(fitScale()); };
  find('plus').onclick = () => stepZoom(1.35);
  find('minus').onclick = () => stepZoom(1 / 1.35);
  const observer = new ResizeObserver(() => {
    if (layout && fitMode && viewport.clientWidth && viewport.clientHeight) setScale(fitScale());
  });
  observer.observe(viewport);
  return {
    show,
    suspend() { requestVersion++; },
    dispose() { requestVersion++; observer.disconnect(); },
  };
}
