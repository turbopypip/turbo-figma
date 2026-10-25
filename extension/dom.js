// Self-contained: Chrome serializes this function into an isolated content-script world.
// No private Figma runtime, cookies, REST endpoints, or document writes.
export async function figmaAction(method, params, fileKey) {
  let nativeCopyStarted = false;
  try {
    if (['get_design_context', 'get_selection'].includes(method)) throw new Error('UI design context was removed; use the network snapshot.');
    const url = new URL(location.href);
    if (url.origin !== 'https://www.figma.com' || !/^\/(design|file)\//.test(url.pathname) || url.pathname.split('/')[2] !== fileKey)
      throw new Error('The paired Figma file changed. Connect the intended file again.');
    const visible = el => el && el.getClientRects().length > 0;
    const label = el => {
      if (el.getAttribute('aria-label')) return el.getAttribute('aria-label').trim();
      const copy = el.cloneNode(true);
      copy.querySelectorAll('[aria-hidden="true"]').forEach(hidden => hidden.remove());
      return copy.textContent.replace(/\u200b/g, '').trim();
    };
    const rows = () => [...document.querySelectorAll('[role="row"]')].filter(el => el.querySelector('[data-testid$="-layers-panel-row"]'));
    const rowId = row => row.querySelector('[data-testid$="-layers-panel-row"]').getAttribute('data-testid').replace(/-layers-panel-row$/, '');
    const describe = row => {
      const item = row.querySelector('[data-testid$="-layers-panel-row"]');
      return { id: item.getAttribute('data-testid').replace(/-layers-panel-row$/, ''),
        name: item.innerText.trim().slice(0, 500), type: row.querySelector('[role="img"][aria-label]')?.getAttribute('aria-label') || 'UNKNOWN',
        hidden: /^var\(\s*--color-text-(?:disabled|component-tertiary)\s*\)$/.test(row.style?.color || ''),
        level: Number(row.getAttribute('aria-level')), expanded: row.getAttribute('aria-expanded') === 'true',
        hasChildren: row.hasAttribute('aria-expanded') };
    };
    // Figma also marks descendants aria-selected; only selected-root is an actual selection.
    const selected = () => rows().filter(row => row.getAttribute('data-fpl-selected-root') === 'true');
    const hover = el => {
      const rect = el.getBoundingClientRect();
      const options = { bubbles: true, cancelable: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
      el.dispatchEvent(new PointerEvent('pointerover', { ...options, pointerType: 'mouse' }));
      el.dispatchEvent(new MouseEvent('mouseover', options));
      el.dispatchEvent(new MouseEvent('mousemove', options));
      return options;
    };
    const activate = el => {
      const options = hover(el);
      el.dispatchEvent(new PointerEvent('pointerdown', { ...options, pointerType: 'mouse', buttons: 1 }));
      el.dispatchEvent(new MouseEvent('mousedown', { ...options, buttons: 1 }));
      el.dispatchEvent(new PointerEvent('pointerup', { ...options, pointerType: 'mouse' }));
      el.dispatchEvent(new MouseEvent('mouseup', options));
      el.click();
    };
    const one = () => {
      const items = selected();
      const count = document.querySelector('[role="application"][aria-label^="Figma Design"]')?.getAttribute('aria-label');
      if (items.length !== 1 || count !== 'Figma Design, 1 item selected')
        throw new Error('Select exactly one visible layer in the Layers panel. The Figma selection count must also be one.');
      return items[0];
    };
    const waitFor = async (predicate, message = 'Figma UI did not become ready. Open Properties and expand the layer in the Layers panel.') => {
      const end = Date.now() + 3500;
      while (Date.now() < end) { const value = predicate(); if (value) return value; await new Promise(r => setTimeout(r, 16)); }
      throw new Error(message);
    };
    const button = text => [...document.querySelectorAll('button,[role="button"]')].find(el => visible(el) && label(el) === text);
    const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
    const started = Date.now(), deadline = started + (method === 'select_node' ? (params.ancestors ? 8000 : 2000) : 18_000);
    const checkFile = () => {
      const current = new URL(location.href);
      if (current.origin !== url.origin || current.pathname.split('/')[2] !== fileKey) throw new Error('Paired file changed during traversal.');
    };
    const mounted = id => rows().find(row => rowId(row) === id);
    let scrollElement;
    const scroller = () => {
      if (scrollElement && scrollElement.isConnected !== false) return scrollElement;
      const tree = document.querySelector('[data-testid="objects-panel"]');
      for (let el = tree; el && el !== document.body; el = el.parentElement) {
        if (el.clientHeight > 0 && el.scrollHeight > el.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(el).overflowY)) { scrollElement = el; return el; }
      }
      return null;
    };
    // Only offsets/IDs, never Figma private state. Cache is bounded and file scoped.
    let cache = globalThis.__figmaKiloLayerOffsets;
    if (!cache || cache.fileKey !== fileKey) cache = globalThis.__figmaKiloLayerOffsets = { fileKey, offsets: new Map() };
    const remember = row => {
      const id = describe(row).id;
      cache.offsets.delete(id); cache.offsets.set(id, scroller()?.scrollTop || 0);
      if (cache.offsets.size > 2000) cache.offsets.delete(cache.offsets.keys().next().value);
    };
    const findRow = async (id, until = deadline) => {
      checkFile();
      if (mounted(id)) return mounted(id);
      const scroll = scroller();
      if (!scroll) return null;
      if (cache.offsets.has(id)) {
        scroll.scrollTop = cache.offsets.get(id); await pause(32);
        if (mounted(id)) return mounted(id);
      }
      // Search already expanded rows. Never expand unrelated document branches.
      scroll.scrollTop = 0; await pause(32);
      for (let step = 0; step < 150 && Date.now() < until; step++) {
        checkFile();
        if (mounted(id)) return mounted(id);
        const before = scroll.scrollTop;
        scroll.scrollTop += Math.max(32, scroll.clientHeight / 2); await pause(32);
        if (scroll.scrollTop === before) break;
      }
      return mounted(id) || null;
    };

    // Screenshot-only path supplied by the network snapshot. Expand just its ancestors.
    if (method === 'select_node' && Array.isArray(params.ancestors)) {
      const layersTab = [...document.querySelectorAll('[role="tab"]')].find(el => label(el) === 'Layers');
      if (layersTab && layersTab.getAttribute('aria-selected') !== 'true') {
        layersTab.click(); await waitFor(() => layersTab.getAttribute('aria-selected') === 'true');
      }
      const layersToggle = button('Layers');
      if (layersToggle?.getAttribute('aria-expanded') === 'false') {
        layersToggle.click();
        await waitFor(() => button('Layers')?.getAttribute('aria-expanded') === 'true' &&
          document.querySelector('[data-testid="objects-panel"]'), 'Layers panel did not expand.');
      }
      if (params.ancestors.length > 64) throw new Error('Screenshot ancestor path exceeds limit');
      for (const id of params.ancestors) {
        checkFile();
        const row = await findRow(id);
        if (!row) throw new Error('Screenshot ancestor is not available on the current page');
        if (row.getAttribute('aria-expanded') === 'false') {
          const caret = row.querySelector('[data-testid="layers-panel-expand-caret"]');
          if (!caret) throw new Error('Screenshot ancestor cannot be expanded');
          caret.click();
          await waitFor(() => mounted(id)?.getAttribute('aria-expanded') === 'true');
        }
      }
    }

    if (['read_export', 'assert_selection', 'download_svg'].includes(method) && (!params.nodeId || describe(one()).id !== params.nodeId))
      throw new Error('Selection changed during export. Retry.');
    if (params.nodeId && !['read_export', 'assert_selection', 'download_svg'].includes(method)) {
      const row = params.mountedOnly ? mounted(params.nodeId) : await findRow(params.nodeId);
      if (!row) throw new Error('Node not found among expanded Layers. Open its page and retry with a fresh network capture.');
      if (selected().length !== 1 || describe(one()).id !== params.nodeId) {
        activate(row);
        await waitFor(() => selected().length === 1 && describe(one()).id === params.nodeId);
        // Allow the inspector to render after selection; data is read again below.
        await new Promise(r => setTimeout(r, 200));
      }
    }
    const node = describe(one());
    const assertSelection = () => { if (selected().length !== 1 || describe(one()).id !== node.id) throw new Error('Selection changed during request. Retry.'); };
    if (method === 'assert_selection' || method === 'select_node') return { result: node };
    if (method === 'prepare_svg') {
      const getFormats = () => [...document.querySelectorAll('[data-testid="export-inspection-panel"] [role="combobox"]')].filter(el =>
        (el.getAttribute('aria-label') || el.getAttribute('data-tooltip')) === 'Export file type');
      if (!getFormats().length) {
        const expand = button('Export');
        if (!expand) throw new Error('Export is unavailable in this file.');
        activate(expand);
      }
      const formats = await waitFor(() => { const items = getFormats(); return items.length ? items : null; });
      if (formats.length !== 1) throw new Error('Keep exactly one export setting in the Export panel.');
      if (label(formats[0]) !== 'SVG' && !formats[0].textContent.trim().match(/^SVG(?:SVG)?$/)) {
        activate(formats[0]);
        const option = await waitFor(() => [...document.querySelectorAll('[role="option"]')].find(el => visible(el) && label(el) === 'SVG'));
        activate(option);
      }
      assertSelection(); return { result: node };
    }
    if (method === 'download_svg') {
      const command = button(`Export ${node.name}`);
      if (!command) throw new Error('SVG export button is unavailable.');
      activate(command); return { result: node };
    }
    if (method === 'begin_export') {
      if (params.format !== 'PNG') throw new Error('Unsupported export format');
      await waitFor(() => document.hasFocus(), 'Keep the Figma tab focused during export.');
      const panel = document.querySelector('[data-testid="properties-inspection-panel"]');
      const dimensions = [...(panel?.querySelectorAll('button') || [])].map(el => el.getAttribute('aria-label') || '')
        .filter(label => /^Copy (Width|Height):/.test(label)).map(label => Number(label.split(':')[1].replace(/[^\d.]/g, '')));
      if (params.format === 'PNG' && dimensions.length === 2 && dimensions[0] * dimensions[1] > 16_000_000)
        throw new Error('Layer exceeds 16 megapixels. Select a smaller layer before copying PNG.');
      // Overwrite before reading so existing clipboard contents are never returned to MCP.
      await navigator.clipboard.writeText(params.marker);
      one().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
      const copyAs = await waitFor(() => [...document.querySelectorAll('[role="menu"] [id]')].find(el => label(el) === 'Copy as'));
      hover(copyAs);
      const command = await waitFor(() => [...document.querySelectorAll('[id]')].find(el => el.id.startsWith(`layerMenu-copy-as-${params.format.toLowerCase()}-`) && visible(el)));
      if (command.getAttribute('aria-disabled') === 'true') throw new Error('Figma does not allow copying this layer.');
      nativeCopyStarted = true;
      activate(command);
      return { result: node };
    }
    if (method === 'read_export') {
      if (params.format !== 'PNG') throw new Error('Clipboard export supports PNG only.');
      // Native copy may briefly move focus to a helper frame.
      if (!document.hasFocus()) return { result: null };
      const items = await navigator.clipboard.read();
      const item = items.find(item => item.types.includes('image/png'));
      if (!item) return { result: null };
      const blob = await item.getType('image/png');
      // Bound decoding memory as well as final output. Native Figma copy itself cannot be cancelled.
      if (blob.size > 12 * 1024 * 1024) throw new Error('Source PNG exceeds 12 MiB. Select a smaller layer.');
      const header = new DataView(await blob.slice(0, 24).arrayBuffer());
      const width = header.getUint32(16), height = header.getUint32(20);
      if (!width || !height || width * height > 16_000_000) throw new Error('Source PNG exceeds 16 megapixels. Select a smaller layer.');
      const bitmap = await createImageBitmap(blob);
      try {
        const scale = Math.min(params.scale || 1, 2048 / Math.max(width, height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
        canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        const data = canvas.toDataURL('image/png').split(',')[1];
        if (data.length > 4 * 1024 * 1024) throw new Error('PNG exceeds 3 MiB. Select a smaller layer.');
        assertSelection();
        return { result: { nodeId: node.id, name: node.name, format: 'PNG', data, scale, scaleBasis: 'clipboard' } };
      } finally { bitmap.close(); }
    }
    throw new Error('Unsupported browser operation');
  } catch (error) { return { error: error.message || 'Browser operation failed', ...(method === 'begin_export' ? { nativeCopyStarted } : {}) }; }
}
