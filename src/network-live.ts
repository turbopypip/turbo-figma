import { safeId } from './network.js';

/** Conservative wire subset: absent fields are unchanged, supported values replace whole fields. */
export const LIVE_LIMITS = { recordBytes: 256 * 1024, changes: 256, batches: 128, bytes: 8 * 1024 * 1024 } as const;
export const liveFields = new Set(['guid', 'phase', 'type', 'parentIndex', 'name', 'visible', 'opacity', 'size', 'transform',
  'cornerRadius', 'rectangleCornerRadii', 'strokeWeight', 'stackMode', 'stackSpacing', 'stackHorizontalPadding',
  'stackVerticalPadding', 'stackPaddingRight', 'stackPaddingBottom', 'resizeToFit', 'minSize', 'maxSize',
  'horizontalConstraint', 'verticalConstraint', 'stackCounterSpacing', 'stackCounterAlignContent',
  'stackChildPrimaryGrow', 'stackPositioning', 'stackWrap', 'stackChildAlignSelf', 'stackPrimaryAlignItems',
  'stackCounterAlignItems', 'stackPrimarySizing', 'stackCounterSizing']);
const liveTypes = new Set(['FRAME', 'GROUP', 'RECTANGLE', 'ELLIPSE', 'LINE', 'TEXT', 'VECTOR']);
export function validateLiveChange(n: Record<string, any>) {
  safeId(n.guid);
  const values: unknown[] = [n];
  let visited = 0;
  while (values.length) {
    if (++visited > 10000) throw new Error('Live value budget exceeded');
    const value = values.pop();
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Nonfinite live value');
    if (value && typeof value === 'object') values.push(...Object.values(value));
  }
  if (n.phase !== undefined && !['CREATED', 'REMOVED'].includes(n.phase)) throw new Error('Unsupported live node phase');
  for (const [field, value] of Object.entries(n)) {
    if (!liveFields.has(field) || value === null || value === undefined) throw new Error(`Unsupported live field: ${field}`);
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Nonfinite live value');
  }
  if (n.parentIndex !== undefined) {
    safeId(n.parentIndex.guid);
    if (typeof n.parentIndex.position !== 'string' || n.parentIndex.position.length > 4096) throw new Error('Invalid live sibling position');
  }
  if (n.type !== undefined && !liveTypes.has(n.type)) throw new Error('Unsupported live node type');
  if (n.phase === 'REMOVED' && Object.keys(n).some(k => !['guid', 'phase'].includes(k))) throw new Error('Removal with additional fields is unsupported');
}
export function assertLiveType(n: Record<string, any>) {
  if (!liveTypes.has(n.type)) throw new Error('Unsupported live target type');
}
