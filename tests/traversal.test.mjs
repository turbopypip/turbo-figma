import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { figmaAction } from '../extension/dom.js';

// A genuinely virtual tree: only three rows exist at a time. Expanding changes
// indices; scrolling unmounts parents; selecting updates inspector properties.
function fixture({ interrupt = false, inspectorDelay = 0, colors = {}, initialExpanded = [], layersCollapsed = false } = {}) {
  const tree = [
    { id: 'root', level: 0, children: true },
    { id: 'group', level: 1, children: true, parent: 'root' },
    { id: 'a', level: 2, parent: 'group' },
    { id: 'b', level: 2, parent: 'group' },
    { id: 'c', level: 1, parent: 'root' },
    { id: 'outside', level: 0, children: true },
  ];
  const expanded = new Set(initialExpanded), selections = [], scrolls = [];
  let inspector = 'root', inspectorAt = 0;
  let selected = 'root', top = 0, now = 0, interrupted = false;
  const visible = () => tree.filter(item => !item.parent || (expanded.has(item.parent) && (item.parent !== 'group' || expanded.has('root'))));
  const body = {};
  let layersOpen = !layersCollapsed, toggleClicks = 0;
  const layersToggle = { getClientRects: () => [1], getAttribute: key => key === 'aria-label' ? 'Layers' : key === 'aria-expanded' ? String(layersOpen) : null, click() { layersOpen = !layersOpen; toggleClicks++; } };
  const scroll = { parentElement: body, clientHeight: 60, get scrollHeight() { return visible().length * 20; },
    get scrollTop() { return top; }, set scrollTop(value) { top = Math.max(0, Math.min(value, this.scrollHeight - 60)); scrolls.push(top); } };
  const panel = { parentElement: scroll, clientHeight: 0 };
  const row = item => ({
    style: { color: colors[item.id] || '' },
    getAttribute: key => ({ 'data-fpl-selected-root': String(selected === item.id), 'aria-level': String(item.level), 'aria-expanded': item.children ? String(expanded.has(item.id)) : null })[key] ?? null,
    hasAttribute: key => key === 'aria-expanded' && item.children,
    querySelector: selector => selector.includes('-layers-panel-row') ? { getAttribute: () => `${item.id}-layers-panel-row`, innerText: item.id }
      : selector.includes('expand-caret') && item.children ? { click: () => expanded.add(item.id) } : null,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 20 }),
    dispatchEvent() {}, click() { selected = item.id; inspectorAt = now + inspectorDelay; if (!inspectorDelay) inspector = selected; selections.push(item.id); },
    scrollIntoView({ block }) {
      const index = visible().findIndex(n => n.id === item.id);
      if (block === 'start' || index * 20 < top || index * 20 >= top + 60) scroll.scrollTop = index * 20;
    },
  });
  const label = value => ({ getClientRects: () => [1], getAttribute: key => key === 'aria-label' ? value : key === 'aria-selected' ? 'true' : null });
  const document = { body,
    querySelector: selector => selector.includes('objects-panel') ? (layersOpen ? panel : null) : { getAttribute: () => 'Figma Design, 1 item selected' },
    querySelectorAll: selector => {
      if (selector === '[role="row"]') return (layersOpen ? visible() : []).slice(Math.floor(top / 20), Math.floor(top / 20) + 3).map(row);
      if (selector === '[role="tab"]') return [label('Properties')];
      if (selector === 'button,[role="button"]') return [layersToggle, label(selected)];
      if (selector === '[data-testid$="inspection-panel"]') return [{ getClientRects: () => [1], getAttribute: () => 'properties-inspection-panel', innerText: `Width of ${inspector}`, querySelectorAll: selector => selector === 'button[aria-label]' ? [label(`Copy Width: ${inspector.length}px`)] : [] }];
      throw new Error(`Unexpected query: ${selector}`);
    },
  };
  const context = vm.createContext({ URL, location: { href: 'https://www.figma.com/design/file/Test' }, document,
    getComputedStyle: () => ({ overflowY: 'auto' }), PointerEvent: class {}, MouseEvent: class {},
    Date: { now: () => now }, setTimeout: (fn, ms) => { now += ms; if (now >= inspectorAt) inspector = selected; if (interrupt && selected === 'group' && !interrupted) { selected = 'outside'; interrupted = true; } fn(); },
  });
  const run = vm.runInContext(`(${figmaAction.toString()})`, context);
  return { run: params => run('get_design_context', params, 'file'), select: params => run('select_node', params, 'file'), expanded, selections, scrolls, get toggleClicks() { return toggleClicks; }, get selected() { return selected; } };
}

test('linked mounted node is selected directly without requiring URL navigation', async () => {
  const f = fixture();
  const result = await f.select({ nodeId: 'outside', mountedOnly: true });
  assert.equal(result.result.id, 'outside');
  assert.equal(f.selected, 'outside');
  assert.match((await f.select({ nodeId: 'a', mountedOnly: true })).error, /not found/);
});



test('screenshot expands only the network ancestor path and selects the exact nested node', async () => {
  const f = fixture();
  const {result,error} = await f.select({nodeId:'b',ancestors:['root','group']});
  assert.equal(error,undefined);
  assert.equal(result.id,'b');
  assert.equal(f.selected,'b');
  assert.deepEqual([...f.expanded],['root','group']);
  assert.deepEqual(f.selections,['b']);
});

test('screenshot opens collapsed Layers before expanding only target ancestors; retry keeps panel open', async () => {
  const f = fixture({layersCollapsed:true});
  for (let i=0;i<2;i++) {
    const r=await f.select({nodeId:'b',ancestors:['root','group']});
    assert.equal(r.error,undefined);assert.equal(r.result.id,'b');
  }
  assert.equal(f.toggleClicks,1);
  assert.deepEqual([...f.expanded],['root','group']);
});
