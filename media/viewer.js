/* The webview uses only local assets and renders schema content as text. */
(() => {
  'use strict';
  const vscode = acquireVsCodeApi();
  const saved = vscode.getState() || {};
  const state = { model: null, selected: null, expanded: new Set(saved.expanded || []), query: saved.query || '', showGroups: !!saved.showGroups, initialized: false, snippet: null };
  let visible = [];
  let nodes = new Map();
  const app = document.getElementById('app');
  const el = (tag, className, text) => { const e = document.createElement(tag); if (className) e.className = className; if (text !== undefined) e.textContent = text; return e; };
  const icons = {
    branch: '<path d="M5 3v14m0-10h9m-9 6h9"/><rect x="13" y="4" width="5" height="5" rx="1"/><rect x="13" y="11" width="5" height="5" rx="1"/>',
    search: '<circle cx="9" cy="9" r="5.5"/><path d="m13 13 4 4"/>',
    code: '<path d="m7 5-5 5 5 5m6-10 5 5-5 5m-2-13-2 16"/>',
    expand: '<path d="M4 8V4h4m4 0h4v4m0 4v4h-4m-4 0H4v-4"/>',
    collapse: '<path d="M4 6h12M4 10h12M4 14h12"/>',
    refresh: '<path d="M16 7a7 7 0 1 0 0 7M16 2v5h-5"/>',
    copy: '<rect x="7" y="7" width="10" height="11" rx="1.5"/><path d="M13 7V3H3v11h4"/>',
    chevron: '<path d="m7 5 5 5-5 5"/>',
    record: '<rect x="3" y="3" width="14" height="14" rx="2"/><path d="M3 7h14M7 7v10"/>',
    element: '<path d="M5 3h7l4 4v10H5zM12 3v5h4M8 11h5m-5 3h5"/>',
    attribute: '<circle cx="10" cy="10" r="7"/><path d="M13 12V7m0 0h-3a2.5 2.5 0 1 0 0 5h3m0-5v5c0 2 4 1 4-2"/>',
    schema: '<path d="M3 4h5l2 2h7v11H3zM7 10l-2 2 2 2m6-4 2 2-2 2"/>',
    choice: '<path d="M4 10h5m0 0 4-5h4m-8 5 4 5h4"/>',
    sequence: '<path d="M3 5h3m3 0h8M3 10h3m3 0h8M3 15h3m3 0h8"/>',
    type: '<path d="m10 2 8 4-8 4-8-4zm-8 8 8 4 8-4m-16 5 8 4 8-4"/>',
    link: '<path d="m8 12 4-4m-6 3-2 2a3 3 0 0 0 4 4l3-3m-2-8 3-3a3 3 0 0 1 4 4l-2 2"/>',
    warning: '<path d="m10 2 8 15H2zM10 7v4m0 3v1"/>',
    check: '<path d="m4 10 4 4 8-8"/>'
  };
  function icon(name, className = '') {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 20 20'); svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.4'); svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round'); svg.setAttribute('aria-hidden', 'true');
    svg.classList.add('icon'); if (className) svg.classList.add(className);
    svg.innerHTML = icons[name] || icons.type; return svg;
  }
  function button(label, iconName, onClick, className = 'button') {
    const b = el('button', className); b.type = 'button'; b.title = label; b.setAttribute('aria-label', label);
    if (iconName) b.append(icon(iconName)); if (className !== 'icon-button') b.append(el('span', '', label)); b.addEventListener('click', onClick); return b;
  }
  const nodeKey = n => `${n.sourceUri}|${n.path}|${n.kind}|${n.name}|${n.line}`;
  const persist = () => vscode.setState({ expanded: [...state.expanded], query: state.query, showGroups: state.showGroups, selected: state.selected && nodeKey(state.selected) });
  function send(type, extra = {}) { vscode.postMessage({ type, id: state.selected?.id, ...extra }); }
  function nodeIcon(n) { return ['all', 'group'].includes(n.kind) ? 'sequence' : n.kind === 'any' ? 'element' : n.kind; }
  function displayName(n) { return ['sequence', 'choice', 'all'].includes(n.kind) ? { sequence: 'Sequence', choice: 'Choice', all: 'All' }[n.kind] : n.name; }
  function buildShell() {
    app.replaceChildren(); app.setAttribute('aria-busy', 'false');
    const header = el('header', 'header');
    const brand = el('div', 'brand'); const mark = el('span', 'brand-mark'); mark.append(icon('branch')); brand.append(mark);
    const brandText = el('div', 'brand-text'); const title = el('div', 'title-line'); title.append(el('h1', '', 'Schema Viewer'), el('span', 'version', 'XSD')); brandText.append(title, el('div', 'subtitle', 'Lambogenius · XML Schema Explorer')); brand.append(brandText);
    const actions = el('div', 'header-actions'); actions.append(button('Open source', 'code', () => send('source')), button('Refresh schema', 'refresh', () => send('refresh'), 'icon-button'));
    header.append(brand, actions);
    const context = el('div', 'context-bar'); const file = el('div', 'file-context'); file.append(icon('schema'), el('span', 'file-name', state.model.name), el('span', 'context-divider', '/'), el('span', 'namespace', state.model.namespace || 'No target namespace')); context.append(file, el('span', 'read-only', 'READ ONLY'));
    const main = el('main', 'main');
    const explorer = el('section', 'explorer'); explorer.setAttribute('aria-label', 'Schema explorer');
    const paneHeading = el('div', 'pane-heading'); const paneLabel = el('div', 'pane-label'); paneLabel.append(el('h2', '', 'SCHEMA EXPLORER'), el('span', 'count-pill', String(state.model.stats.nodes)));
    const treeActions = el('div', 'tree-actions');
    treeActions.append(button('Expand all', 'expand', () => { nodes.forEach(n => state.expanded.add(nodeKey(n))); renderTree(); persist(); }, 'icon-button'), button('Collapse all', 'collapse', () => { state.expanded.clear(); state.expanded.add(nodeKey(state.model.roots[0])); renderTree(); persist(); }, 'icon-button'));
    paneHeading.append(paneLabel, treeActions);
    const searchWrap = el('div', 'search-wrap'); const searchBox = el('div', 'search-box'); const search = el('input', 'search'); search.type = 'search'; search.placeholder = 'Find a record, field, or type…'; search.setAttribute('aria-label', 'Search schema'); search.value = state.query;
    search.addEventListener('input', () => { state.query = search.value; renderTree(); persist(); });
    const shortcut = el('kbd', 'search-key', '⌘ / Ctrl F'); searchBox.append(icon('search'), search, shortcut); searchWrap.append(searchBox);
    const options = el('div', 'tree-options'); const toggleLabel = el('label', 'toggle-label'); const toggle = el('input'); toggle.type = 'checkbox'; toggle.checked = state.showGroups; toggle.addEventListener('change', () => { state.showGroups = toggle.checked; renderTree(); persist(); }); toggleLabel.append(toggle, el('span', '', 'Show compositors')); options.append(toggleLabel, el('span', 'linked-count', `${state.model.dependencies.length} linked ${state.model.dependencies.length === 1 ? 'schema' : 'schemas'}`));
    const columns = el('div', 'tree-columns'); columns.append(el('span', '', 'NODE'), el('span', '', 'DATA TYPE'), el('span', '', 'OCCURS'));
    const tree = el('div', 'tree'); tree.id = 'tree'; tree.setAttribute('role', 'tree'); tree.setAttribute('aria-label', 'XML schema nodes'); tree.addEventListener('keydown', treeKeydown);
    const warningArea = el('div', 'warnings'); warningArea.id = 'warnings';
    explorer.append(paneHeading, searchWrap, options, columns, tree, warningArea);
    const divider = el('div', 'splitter'); divider.setAttribute('role', 'separator'); divider.setAttribute('aria-label', 'Resize properties pane'); divider.setAttribute('aria-orientation', 'vertical'); divider.tabIndex = 0;
    let dragging = false;
    divider.addEventListener('pointerdown', event => { dragging = true; divider.setPointerCapture(event.pointerId); });
    divider.addEventListener('pointerup', () => { dragging = false; });
    divider.addEventListener('pointermove', event => { if (dragging) main.style.setProperty('--inspector-width', `${Math.min(620, Math.max(280, main.getBoundingClientRect().right - event.clientX))}px`); });
    divider.addEventListener('keydown', event => { if (['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); const current = main.querySelector('.inspector').getBoundingClientRect().width; main.style.setProperty('--inspector-width', `${Math.min(620, Math.max(280, current + (event.key === 'ArrowLeft' ? 24 : -24)))}px`); } });
    const inspector = el('aside', 'inspector'); inspector.id = 'inspector'; inspector.setAttribute('aria-label', 'Selected node properties');
    main.append(explorer, divider, inspector);
    const footer = el('footer', 'statusbar'); const stats = el('div', 'stats');
    for (const [kind, count, label] of [['record', state.model.stats.records, 'records'], ['element', state.model.stats.fields, 'fields'], ['attribute', state.model.stats.attributes, 'attributes']]) {
      const stat = el('span', 'stat'); stat.append(icon(kind), el('span', '', `${count} ${label}`)); stats.append(stat);
    }
    const sync = el('span', 'sync-status'); sync.append(el('span', 'status-dot'), el('span', '', 'Source stays in sync')); footer.append(stats, sync);
    const toast = el('div', 'toast'); toast.id = 'toast'; toast.setAttribute('role', 'status'); toast.hidden = true;
    app.append(header, context, main, footer, toast);
    document.onkeydown = event => { if ((event.ctrlKey || event.metaKey) && event.key === 'f') { event.preventDefault(); search.focus(); search.select(); } if (event.key === 'Escape' && document.activeElement === search) { search.value = ''; state.query = ''; renderTree(); persist(); tree.querySelector('[aria-selected="true"]')?.focus(); } };
  }
  function matching(n) {
    const q = state.query.trim().toLowerCase();
    return !q || [n.name, n.type, n.path, n.documentation, n.kind].some(value => value.toLowerCase().includes(q));
  }
  function renderTree() {
    const tree = document.getElementById('tree'); tree.replaceChildren(); visible = [];
    const query = state.query.trim();
    const matches = new Map();
    function hasMatch(n) { if (!matches.has(n.id)) matches.set(n.id, matching(n) || n.children.some(hasMatch)); return matches.get(n.id); }
    function draw(n, depth, inheritedHidden = false) {
      if (query && !hasMatch(n)) return;
      const hidden = !state.showGroups && ['sequence', 'all'].includes(n.kind);
      if (hidden) { n.children.forEach(child => draw(child, depth, true)); return; }
      const expanded = query || state.expanded.has(nodeKey(n));
      const row = el('div', `tree-row kind-${n.kind}${state.selected?.id === n.id ? ' selected' : ''}${query && !matching(n) ? ' ancestor-match' : ''}`);
      row.setAttribute('role', 'treeitem'); row.setAttribute('aria-level', String(depth + 1)); row.setAttribute('aria-selected', String(state.selected?.id === n.id));
      if (n.children.length) row.setAttribute('aria-expanded', String(!!expanded));
      row.tabIndex = state.selected?.id === n.id || (!visible.length && !visible.some(x => x.node.id === state.selected?.id)) ? 0 : -1;
      row.dataset.id = n.id; row.style.setProperty('--depth', String(depth));
      row.title = `${n.path}\n${n.type || n.kind}${n.warning ? `\n${n.warning}` : ''}`;
      const nameCell = el('div', 'node-cell');
      if (n.children.length) {
        const chevron = button(expanded ? 'Collapse node' : 'Expand node', 'chevron', event => { event.stopPropagation(); if (state.expanded.has(nodeKey(n))) state.expanded.delete(nodeKey(n)); else state.expanded.add(nodeKey(n)); renderTree(); persist(); document.querySelector(`.tree-row[data-id="${n.id}"]`)?.focus(); }, 'icon-button');
        chevron.tabIndex = -1; chevron.classList.add('tree-chevron'); if (expanded) chevron.classList.add('expanded'); nameCell.append(chevron);
      } else nameCell.append(el('span', 'leaf-spacer'));
      nameCell.append(icon(nodeIcon(n), 'node-icon'), el('span', 'node-name', displayName(n)));
      if (n.recursive) nameCell.append(el('span', 'recursive-badge', '↻'));
      if (n.kind === 'choice') nameCell.append(el('span', 'choice-label', 'one of'));
      if (n.warning) nameCell.append(icon('warning', 'node-warning'));
      const type = el('span', 'type-cell', n.type.replace(/^(xs|xsd):/, '')); if (!n.type && ['sequence', 'choice', 'all'].includes(n.kind)) type.textContent = 'compositor';
      const occurrence = el('div', 'occurs-cell');
      if (['record', 'element', 'attribute', 'sequence', 'choice', 'all', 'any', 'group'].includes(n.kind)) {
        const range = n.min === n.max ? n.min : `${n.min}..${n.max === 'unbounded' ? '∞' : n.max}`;
        occurrence.append(el('span', `occurs-badge${n.min === '0' ? ' optional' : ''}${n.max === 'unbounded' ? ' repeating' : ''}`, range));
      }
      row.append(nameCell, type, occurrence);
      row.addEventListener('click', () => select(n, true)); row.addEventListener('dblclick', () => send('source', { id: n.id }));
      tree.append(row); visible.push({ node: n, depth, row });
      if (expanded) n.children.forEach(child => draw(child, depth + 1));
    }
    state.model.roots.forEach(root => draw(root, 0));
    if (!visible.length) {
      const empty = el('div', 'empty-search'); empty.append(icon('search'), el('h3', '', 'No matching nodes'), el('p', '', `Try another name or data type.`)); tree.append(empty);
    }
    // A flat DOM still follows the tree keyboard model and explicit aria-level hierarchy.
    const selectedRow = visible.find(x => x.node.id === state.selected?.id);
    visible.forEach((x, i) => { x.row.tabIndex = selectedRow ? (x === selectedRow ? 0 : -1) : (i === 0 ? 0 : -1); });
    renderWarnings();
  }
  function treeKeydown(event) {
    const index = visible.findIndex(x => x.node.id === event.target.closest('.tree-row')?.dataset.id);
    if (index < 0) return;
    const current = visible[index]; let next = index;
    if (event.key === 'ArrowDown') next = Math.min(index + 1, visible.length - 1);
    else if (event.key === 'ArrowUp') next = Math.max(0, index - 1);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = visible.length - 1;
    else if (event.key === 'ArrowRight') {
      if (current.node.children.length && !state.expanded.has(nodeKey(current.node))) { state.expanded.add(nodeKey(current.node)); renderTree(); persist(); }
      else if (visible[index + 1]?.depth > current.depth) next++;
    } else if (event.key === 'ArrowLeft') {
      if (state.expanded.has(nodeKey(current.node)) && current.node.children.length) { state.expanded.delete(nodeKey(current.node)); renderTree(); persist(); }
      else { for (let i = index - 1; i >= 0; i--) if (visible[i].depth < current.depth) { next = i; break; } }
    } else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(current.node, true); return; }
    else return;
    event.preventDefault(); if (visible[next]) select(visible[next].node, true);
  }
  function select(n, focus = false) {
    state.selected = n; state.snippet = null;
    document.querySelectorAll('.tree-row').forEach(row => { const selected = row.dataset.id === n.id; row.classList.toggle('selected', selected); row.setAttribute('aria-selected', String(selected)); row.tabIndex = selected ? 0 : -1; if (selected && focus) row.focus({ preventScroll: true }); });
    if (focus) document.querySelector(`.tree-row[data-id="${n.id}"]`)?.scrollIntoView({ block: 'nearest' });
    renderInspector(); send('selection'); persist();
  }
  function renderInspector() {
    const pane = document.getElementById('inspector'); pane.replaceChildren(); const n = state.selected; if (!n) return;
    const heading = el('div', 'pane-heading'); heading.append(el('h2', '', 'NODE PROPERTIES'), button('Copy XPath', 'copy', () => send('copyPath'), 'icon-button'));
    const identity = el('div', `node-identity kind-${n.kind}`); const largeIcon = el('span', 'identity-icon'); largeIcon.append(icon(nodeIcon(n))); const identityText = el('div'); identityText.append(el('h3', '', displayName(n)), el('span', 'identity-kind', n.kind === 'record' ? 'Record element' : n.kind === 'element' ? 'Field element' : `${n.kind.charAt(0).toUpperCase()}${n.kind.slice(1)}`)); identity.append(largeIcon, identityText);
    const breadcrumb = el('div', 'breadcrumb', n.path); breadcrumb.title = n.xpath;
    const properties = el('div', 'properties');
    if (n.documentation) { const doc = el('div', 'documentation'); doc.append(el('span', 'eyebrow', 'DOCUMENTATION'), el('p', '', n.documentation)); properties.append(doc); }
    if (n.warning) { const warning = el('div', 'node-alert'); warning.append(icon('warning'), el('span', '', n.warning)); properties.append(warning); }
    const categories = [...new Set(n.properties.map(p => p.category))];
    for (const category of categories) {
      if (category === 'Documentation' || category === 'Navigation') continue;
      const section = el('section', 'property-section'); section.append(el('h4', '', category));
      const dl = el('dl', 'property-list');
      for (const p of n.properties.filter(p => p.category === category)) {
        const pair = el('div', 'property-pair'); pair.append(el('dt', '', p.name), el('dd', p.name.toLowerCase().includes('type') ? 'property-type' : '', p.value)); dl.append(pair);
      }
      section.append(dl); properties.append(section);
    }
    const source = el('section', 'source-preview'); const sourceHeader = el('div', 'source-heading'); const sourceTitle = el('span'); sourceTitle.append(icon('code'), el('span', '', 'SOURCE PREVIEW')); sourceHeader.append(sourceTitle, button('Reveal in source', null, () => send('source'), 'source-link'));
    const sourceMeta = el('div', 'source-meta', 'Loading source…'); sourceMeta.id = 'source-meta';
    const pre = el('pre', 'source-code'); pre.id = 'source-code'; pre.setAttribute('aria-label', 'Selected node source');
    source.append(sourceHeader, sourceMeta, pre);
    pane.append(heading, identity, breadcrumb, properties, source);
  }
  function renderWarnings() {
    const container = document.getElementById('warnings'); container.replaceChildren();
    if (!state.model.warnings.length) { container.hidden = true; return; } container.hidden = false;
    const details = el('details'); const summary = el('summary'); summary.append(icon('warning'), el('span', '', `${state.model.warnings.length} schema ${state.model.warnings.length === 1 ? 'notice' : 'notices'}`));
    const list = el('ul'); state.model.warnings.forEach(w => list.append(el('li', '', w))); details.append(summary, list); container.append(details);
  }
  function renderSnippet(message) {
    if (message.id !== state.selected?.id) return;
    document.getElementById('source-meta').textContent = `${message.name} : ${message.line}${message.truncated ? ' · preview truncated' : ''}`;
    const pre = document.getElementById('source-code'); pre.replaceChildren();
    message.text.split('\n').forEach((line, index) => {
      const row = el('span', 'code-line'); row.append(el('span', 'line-number', String(message.line + index)));
      const code = el('span', 'code-text');
      // Highlight only tokens; schema markup is never interpreted as HTML.
      const regex = /("[^"]*"|'[^']*'|<\/?[\w:.-]+|\b[\w:.-]+(?=\s*=)|\/?>)/g;
      let last = 0;
      for (const match of line.matchAll(regex)) {
        code.append(document.createTextNode(line.slice(last, match.index)));
        const token = match[0]; code.append(el('span', token.startsWith('"') || token.startsWith("'") ? 'token-string' : token.startsWith('<') || token.endsWith('>') ? 'token-tag' : 'token-attribute', token)); last = match.index + token.length;
      }
      code.append(document.createTextNode(line.slice(last))); row.append(code); pre.append(row);
    });
  }
  window.addEventListener('message', event => {
    const message = event.data;
    if (message.type === 'model') {
      const selectedKey = state.selected ? nodeKey(state.selected) : saved.selected;
      state.model = message.model; nodes = new Map();
      function index(n, depth) { nodes.set(n.id, n); if (!state.initialized && !saved.expanded && depth < 5) state.expanded.add(nodeKey(n)); n.children.forEach(c => index(c, depth + 1)); }
      state.model.roots.forEach(n => index(n, 0)); state.initialized = true;
      const selected = [...nodes.values()].find(n => nodeKey(n) === selectedKey) || state.model.roots[0].children.find(n => n.kind === 'record' || n.kind === 'element') || state.model.roots[0];
      state.selected = selected; buildShell(); renderTree(); select(selected);
    } else if (message.type === 'snippet') renderSnippet(message);
    else if (message.type === 'copied') {
      const toast = document.getElementById('toast'); toast.replaceChildren(icon('check'), el('span', '', 'XPath copied to clipboard')); toast.hidden = false; setTimeout(() => { toast.hidden = true; }, 2200);
    } else if (message.type === 'error') {
      state.model = null; state.selected = null; app.replaceChildren(); app.setAttribute('aria-busy', 'false');
      const error = el('main', 'error-state'); const mark = el('span', 'error-mark'); mark.append(icon('warning')); error.append(mark, el('span', 'eyebrow', message.name || 'XML SCHEMA'), el('h1', '', 'Unable to read this schema'), el('p', '', message.message), button('Open source', 'code', () => send('source')), button('Try again', 'refresh', () => send('refresh'))); app.append(error);
    }
  });
  send('ready');
})();
