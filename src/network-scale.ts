type Node = Record<string, any>;

export function instanceScale(value: unknown = 1): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error('Invalid instance scale factor');
  return value;
}

// Scale lengths only. Matrix basis, percentages, colors, opacity, IDs and grow
// factors are dimensionless. Symbol overrides retain their own coordinate space.
const lengths = ['fontSize', 'paragraphSpacing', 'paragraphIndent', 'strokeWeight', 'cornerRadius',
  'rectangleTopLeftCornerRadius', 'rectangleTopRightCornerRadius', 'rectangleBottomLeftCornerRadius', 'rectangleBottomRightCornerRadius',
  'borderTopWeight', 'borderRightWeight', 'borderBottomWeight', 'borderLeftWeight',
  'stackSpacing', 'stackCounterSpacing', 'stackHorizontalPadding', 'stackVerticalPadding', 'stackPaddingRight', 'stackPaddingBottom'];

export function scaleNode(node: Node, factor: number): Node {
  instanceScale(factor);
  if (factor === 1) return node;
  const multiply = (value: number) => {
    const result = value * factor;
    if (!Number.isFinite(value) || !Number.isFinite(result)) throw new Error('Instance scale length overflow');
    return result;
  };
  const fields = (value: Node, keys: string[]) => {
    const out = {...value};
    for (const key of keys) if (typeof out[key] === 'number') out[key] = multiply(out[key]);
    return out;
  };
  const out = fields(node, lengths);
  for (const key of ['size', 'minSize', 'maxSize']) if (node[key]) out[key] = {...fields(node[key], ['x', 'y']),
    ...(node[key].value ? {value: fields(node[key].value, ['x', 'y'])} : {})};
  if (node.transform) out.transform = fields(node.transform, ['m02', 'm12']);
  for (const key of ['lineHeight', 'letterSpacing']) if (node[key]?.units === 'PIXELS') out[key] = fields(node[key], ['value']);
  for (const key of ['dashPattern', 'rectangleCornerRadii']) if (Array.isArray(node[key])) out[key] = node[key].map((v: unknown) => typeof v === 'number' ? multiply(v) : v);
  if (Array.isArray(node.effects)) out.effects = node.effects.map((effect: Node) => ({...fields(effect, ['radius', 'spread']),
    ...(effect.offset ? {offset: fields(effect.offset, ['x', 'y'])} : {})}));
  if (Array.isArray(node.textData?.styleOverrideTable)) out.textData = {...node.textData,
    styleOverrideTable: node.textData.styleOverrideTable.map((style: Node) => scaleNode(style, factor))};
  return out;
}
