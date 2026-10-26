import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { figmaAction } from '../extension/dom.js';

function browserFixture({ url = 'https://www.figma.com/design/test/File', selectedId = '1:1', clipboard = '', focused = true, capture, exportCollapsed = false, exportFormat = 'SVG', exportScale = '1x', tooltipValue } = {}) {
  const calls = { read: 0, write: 0, click: 0 };
  let exportOpen = false, scaleMenu = false;
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
    querySelector: selector => {
      if(selector.includes('input[role="spinbutton"]')) return {get value(){return exportScale;},getAttribute:()=>exportScale};
      if(selector === '[data-testid="export-inspection-panel"]') return {querySelectorAll:()=>[{...labeled('Select an option'),getBoundingClientRect:()=>({left:0,top:0,width:10,height:10}),dispatchEvent(){},click(){scaleMenu=true;}}]};
      return {getAttribute:()=> 'Figma Design, 1 item selected'};
    },
    querySelectorAll: selector => {
      if (selector === '[role="row"]') return rows;
      if (selector === '[role="tab"]') return [labeled('Properties', 'true')];
      if (selector === 'button,[role="button"]') return exportCollapsed ? [{ ...labeled('Export'), getBoundingClientRect: () => ({left:0,top:0,width:10,height:10}), dispatchEvent: event => { if (event.type === 'mousedown') exportOpen = true; }, click: () => { calls.click++; } }] : [labeled(`Node ${selectedId}`)];
      if (selector === '[data-testid="export-inspection-panel"] [role="combobox"]') return exportOpen ? [{ ...labeled(exportFormat), getAttribute: key => key === 'data-tooltip' ? 'Export file type' : null }] : [];
      if(selector.includes('[role="menuitemradio"]')) return scaleMenu ? [{...labeled('1x'),getBoundingClientRect:()=>({left:0,top:0,width:10,height:10}),dispatchEvent(){},click(){exportScale='1x';}}] : [];
      if (selector === '[data-testid$="inspection-panel"]') return [panel];
      throw new Error(`Unexpected DOM query ${selector}`);
    },
  };
  const context = { PointerEvent: class { constructor(type) { this.type = type; } }, MouseEvent: class { constructor(type) { this.type = type; } }, URL, location: { href: url }, document, setTimeout, TextEncoder, DataView, __turboFigmaExport: capture,
    btoa: value => Buffer.from(value, 'binary').toString('base64'),
    navigator: { clipboard: { readText: async () => { calls.read++; return clipboard; }, writeText: async () => { calls.write++; } } } };
  const action = vm.runInNewContext(`(${figmaAction.toString()})`, context);
  return { calls, run: (method, params = {}) => action(method, { autoTraverse: false, ...params }, 'test') };
}

test('legacy UI context is rejected without clipboard access', async () => {
  const { run, calls } = browserFixture();
  assert.match((await run('get_design_context')).error, /removed/);
  assert.deepEqual(calls, { read: 0, write: 0, click: 0 });
});

test('browser rejects another file/origin, missing nodes, and changed export selection before clipboard access', async () => {
  for (const url of ['https://www.figma.com/design/other/File', 'https://example.com/design/test/File', 'https://www.figma.com/proto/test/File']) {
    const { run, calls } = browserFixture({ url });
    assert.match((await run('select_node')).error, /file changed/);
    assert.equal(calls.read, 0);
  }
  const { run, calls } = browserFixture();
  assert.match((await run('select_node', { nodeId: 'missing' })).error, /not found/);
  assert.match((await run('assert_selection', { nodeId: '2:1', format: 'PNG' })).error, /Selection changed/);
  assert.equal(calls.read, 0);
  assert.equal(calls.click, 0);
});

test('extension declares debugger for capture without adding broad host permissions', async () => {
  const manifest = JSON.parse(await readFile('extension/manifest.json', 'utf8'));
  assert.deepEqual(manifest.permissions.sort(), ['activeTab', 'alarms', 'debugger', 'scripting', 'storage']);
  assert.equal(manifest.minimum_chrome_version, '125');
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.content_scripts, undefined);
});


test('SVG preparation opens a collapsed Export panel through pointer/mouse activation', async () => {
  const { run, calls } = browserFixture({ exportCollapsed: true });
  const result = await run('prepare_export', {format:'SVG'});
  assert.equal(result.result.id, '1:1');
  assert.equal(calls.click, 1);
});

test('selection expands collapsed ancestors root first before selecting the target', async () => {
  const expanded = new Set(), clicks = [];
  let selectedId = 'outer';
  const row = id => ({
    getAttribute: key => ({'aria-expanded': String(expanded.has(id)), 'data-fpl-selected-root': String(selectedId === id), 'aria-level': '1'})[key] ?? null,
    hasAttribute: () => true,
    getBoundingClientRect: () => ({left:0, top:0, width:10, height:10}),
    dispatchEvent: () => {},
    click: () => { selectedId = id; clicks.push(id); },
    querySelector: selector => selector.includes('expand-caret') ? {click: () => { expanded.add(id); clicks.push(`expand:${id}`); }}
      : selector.includes('layers-panel-row') ? {getAttribute: () => `${id}-layers-panel-row`, innerText:id} : null,
  });
  const document = {
    querySelectorAll: selector => selector === '[role="row"]'
      ? ['outer', ...(expanded.has('outer') ? ['inner'] : []), ...(expanded.has('inner') ? ['target'] : [])].map(row) : [],
    querySelector: () => ({getAttribute: () => 'Figma Design, 1 item selected'}),
  };
  const action = vm.runInNewContext(`(${figmaAction.toString()})`, {document, URL, location:{href:'https://www.figma.com/design/test/File'}, setTimeout, PointerEvent:class {}, MouseEvent:class {}});
  const result = await action('select_node', {nodeId:'target', ancestors:['outer','inner']}, 'test');
  assert.equal(result.error, undefined);
  assert.equal(result.result.id, 'target');
  assert.deepEqual(clicks, ['expand:outer','expand:inner','target']);
});

test('PNG preparation resets a previous 2x setting through the native scale menu',async()=>{
 const {run}=browserFixture({exportCollapsed:true,exportFormat:'PNG',exportScale:'2x'});
 const result=await run('prepare_export',{format:'PNG'});
 assert.equal(result.error,undefined);
 assert.equal(result.result.id,'1:1');
});
