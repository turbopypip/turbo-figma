import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { figmaAction } from '../extension/dom.js';

function browserFixture({ url = 'https://www.figma.com/design/test/File', selectedId = '1:1', clipboard = '', focused = true, capture, exportCollapsed = false, tooltipValue } = {}) {
  const calls = { read: 0, write: 0, click: 0 };
  let exportOpen = false;
  const labeled = (text, selected = null) => ({
    getClientRects: () => [1],
    textContent: text + text,
    getAttribute: key => key === 'aria-selected' ? selected : null,
    cloneNode: () => {
      let hidden = true;
      return { get textContent() { return hidden ? text + text : text; },
        querySelectorAll: () => [{ remove: () => { hidden = false; } }] };
    },
  });
  const rows = ['1:1', '2:1', '3:1'].map((id, i) => ({
    getAttribute: key => ({ 'aria-selected': 'true', 'data-fpl-selected-root': String(id === selectedId), 'aria-level': String(i ? 1 : 0), 'aria-expanded': 'true' })[key] ?? null,
    hasAttribute: key => key === 'aria-expanded' && i === 0,
    querySelector: selector => selector.includes('layers-panel-row') ? { getAttribute: () => `${id}-layers-panel-row`, innerText: `Node ${id}` } : null,
    click: () => { calls.click++; },
  }));
  const panel = { getClientRects: () => [1], getAttribute: () => 'properties-inspection-panel', innerText: 'Layout\nWidth\n100px\nHeight\n200px' };
  if (tooltipValue !== undefined) {
    const pill = { innerText: 'Spacing/sp-xl', querySelectorAll: () => [{ getAttribute: () => tooltipValue }] };
    panel.innerText = 'Padding Top Spacing/sp-xl';
    panel.querySelectorAll = selector => selector === 'button[aria-label]' ? [{ getAttribute: () => 'Copy Padding—Top: Spacing/sp-xl', querySelector: () => pill }] : [pill];
  }
  const document = {
    hasFocus: () => focused,
    querySelector: () => ({ getAttribute: () => 'Figma Design, 1 item selected' }),
    querySelectorAll: selector => {
      if (selector === '[role="row"]') return rows;
      if (selector === '[role="tab"]') return [labeled('Properties', 'true')];
      if (selector === 'button,[role="button"]') return exportCollapsed ? [{ ...labeled('Export'), getBoundingClientRect: () => ({left:0,top:0,width:10,height:10}), dispatchEvent: event => { if (event.type === 'mousedown') exportOpen = true; }, click: () => { calls.click++; } }] : [labeled(`Node ${selectedId}`)];
      if (selector === '[data-testid="export-inspection-panel"] [role="combobox"]') return exportOpen ? [{ ...labeled('SVG'), getAttribute: key => key === 'data-tooltip' ? 'Export file type' : null }] : [];
      if (selector === '[data-testid$="inspection-panel"]') return [panel];
      throw new Error(`Unexpected DOM query ${selector}`);
    },
  };
  const context = { PointerEvent: class { constructor(type) { this.type = type; } }, MouseEvent: class { constructor(type) { this.type = type; } }, URL, location: { href: url }, document, setTimeout, TextEncoder, DataView, __figmaKiloExport: capture,
    btoa: value => Buffer.from(value, 'binary').toString('base64'),
    navigator: { clipboard: { readText: async () => { calls.read++; return clipboard; }, writeText: async () => { calls.write++; } } } };
  const action = vm.runInNewContext(`(${figmaAction.toString()})`, context);
  return { calls, run: (method, params = {}) => action(method, { autoTraverse: false, ...params }, 'test') };
}

test('browser context is explicitly incomplete and obeys the visible node budget', async () => {
  const { run, calls } = browserFixture();
  const selection = await run('get_selection');
  assert.equal(selection.result.nodes[0].id, '1:1');
  const { result } = await run('get_design_context', { depth: 2, maxNodes: 2 });
  assert.equal(result.truncated, true);
  assert.equal(result.nodeCount, 2);
  assert.equal(result.visibleDescendants[0].id, '2:1');
  assert.match(result.properties[0].text, /100px/);
  assert.ok(result.unavailable.includes('complete hierarchy'));
  assert.deepEqual(calls, { read: 0, write: 0, click: 0 });
  assert.equal((await run('get_design_context', { depth: 0, maxNodes: 10 })).result.nodeCount, 1);
});

test('browser rejects another file/origin, missing nodes, and changed export selection before clipboard access', async () => {
  for (const url of ['https://www.figma.com/design/other/File', 'https://example.com/design/test/File', 'https://www.figma.com/proto/test/File']) {
    const { run, calls } = browserFixture({ url });
    assert.match((await run('get_selection')).error, /file changed/);
    assert.equal(calls.read, 0);
  }
  const { run, calls } = browserFixture();
  assert.match((await run('get_design_context', { nodeId: 'missing' })).error, /not found/);
  assert.match((await run('read_export', { nodeId: '2:1', format: 'PNG' })).error, /Selection changed/);
  assert.equal(calls.read, 0);
  assert.equal(calls.click, 0);
});

test('export waits without reading clipboard while Figma is unfocused', async () => {
  const { run, calls } = browserFixture({ focused: false, clipboard: '<svg/>' });
  assert.equal((await run('read_export', { nodeId: '1:1', format: 'PNG' })).result, null);
  assert.equal(calls.read, 0);
});

test('extension declares debugger for capture without adding broad host permissions', async () => {
  const manifest = JSON.parse(await readFile('extension/manifest.json', 'utf8'));
  assert.deepEqual(manifest.permissions.sort(), ['activeTab', 'alarms', 'clipboardRead', 'clipboardWrite', 'debugger', 'scripting', 'storage']);
  assert.equal(manifest.minimum_chrome_version, '125');
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.content_scripts, undefined);
});


test('SVG preparation opens a collapsed Export panel through pointer/mouse activation', async () => {
  const { run, calls } = browserFixture({ exportCollapsed: true });
  const result = await run('prepare_svg');
  assert.equal(result.result.id, '1:1');
  assert.equal(calls.click, 1);
});

test('current tooltip attribute replaces Figma naming without cached/hardcoded values', async () => {
  for (const actual of ['32px', '40px', '']) {
    const { run } = browserFixture({ tooltipValue: actual });
    const { result } = await run('get_design_context');
    assert.equal(result.properties[0].fields[0].value, actual || 'unavailable');
    assert.equal(JSON.stringify(result).includes('Spacing/sp-xl'), false);
  }
});
