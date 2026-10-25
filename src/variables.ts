import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import path from 'node:path';

export function variablesPath(input: string, platform = process.platform): string {
  const value = input.trim().replace(/^(["'])(.*)\1$/, '$2');
  if (platform !== 'win32' && path.win32.isAbsolute(value) && !path.posix.isAbsolute(value))
    throw new Error('Windows variablesFile must be read by MCP running on Windows. Provide a local path on this machine.');
  if (!(platform === 'win32' ? path.win32 : path.posix).isAbsolute(value)) throw new Error('variablesFile must be an absolute local path.');
  if (!/\.(scss|css)$/i.test(value)) throw new Error('variablesFile must be a .scss or .css file.');
  return value;
}

const aliases = new WeakMap<Map<string, string>, Set<string>>();

// Read declarations, never execute Sass or load imports. Duplicate definitions are excluded
// because selecting a theme/mode from a source file would require runtime context.
export function parseVariables(source: string): Map<string, string> {
  const declarations = new Map<string, string[]>();
  const cleaned = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const roots: string[] = [];
  const remainder = cleaned.replace(/:root\s*\{([^{}]*)\}/g, (_, body: string) => { roots.push(body); return ''; });
  if (remainder.trim()) throw new Error('variablesFile supports flat :root declarations only; Sass imports, nesting and theme selectors must be exported to a separate flat file.');
  for (const match of roots.join('\n').matchAll(/(--[\w-]+)\s*:\s*([^;{}]+)\s*;/g)) {
    const values = declarations.get(match[1]) || [];
    values.push(match[2].trim()); declarations.set(match[1], values);
  }
  const resolve = (name: string, seen = new Set<string>()): string | undefined => {
    const values = declarations.get(name);
    if (!values || values.length !== 1 || seen.has(name)) return;
    seen.add(name);
    const alias = /^var\(\s*(--[\w-]+)\s*\)$/.exec(values[0]);
    return alias ? resolve(alias[1], seen) : values[0];
  };
  const result = new Map<string, string>();
  for (const name of declarations.keys()) { const value = resolve(name); if (value) result.set(name, value); }
  aliases.set(result, new Set([...declarations].filter(([, values]) => /^var\(/.test(values[0])).map(([name]) => name)));
  return result;
}

export async function loadVariables(input: string): Promise<Map<string, string>> {
  const handle = await open(variablesPath(input), 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 2 * 1024 * 1024) throw new Error('variablesFile must be a regular file up to 2 MiB.');
    const buffer = Buffer.alloc(2 * 1024 * 1024 + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 2 * 1024 * 1024) throw new Error('variablesFile exceeds 2 MiB.');
    return parseVariables(buffer.subarray(0, bytesRead).toString('utf8'));
  } finally { await handle.close(); }
}

const isColorProperty = (property: string) => /^(color|background-color|(?:border(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)|outline|text-decoration|column-rule)-color|fill|stroke|caret-color|accent-color)$/.test(property);
const category = (property: string): RegExp | undefined => {
  if (/^(padding|margin)(-|$)|^(gap|row-gap|column-gap|(?:min-|max-)?(?:width|height)|top|right|bottom|left|inset(?:-.*)?|line-height|flex-basis)$/.test(property)) return /^--mimir-space-/;
  if (/^border(-.*)?-radius$/.test(property)) return /^--mimir-control-(?:input-)?radius(?:-|$)/;
  if (/^border(?:-.*)?-width$/.test(property)) return /^--mimir-control-border-width$/;
  if (property === 'font-size') return /^--mimir-size-text-/;
  if (property === 'font-weight') return /^--mimir-font-weight-text-/;
  if (property === 'font-family') return /^--mimir-font-(?:inter|montserrat)$/;
  return undefined;
};
const normalize = (value: string) => {
  const number = /^(-?(?:\d+(?:\.\d+)?|\.\d+))(px|em|rem|%)?$/.exec(value.trim());
  return number ? `${Number(number[1])}${number[2] || ''}` : value.trim();
};
// Exact color equivalence only; never discard alpha or approximate channels.
function colorKey(value: string): string | undefined {
  value = value.trim().toLowerCase();
  value = ({white:'#ffffff', black:'#000000', transparent:'#00000000'} as Record<string,string>)[value] || value;
  const hex = /^#([\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/.exec(value);
  if (hex) {
    const h = hex[1].length < 5 ? [...hex[1]].map(c => c+c).join('') : hex[1];
    return [parseInt(h.slice(0,2),16),parseInt(h.slice(2,4),16),parseInt(h.slice(4,6),16),h.length === 8 ? parseInt(h.slice(6),16)/255 : 1].join(',');
  }
  const rgb = /^rgba?\(([^()]+)\)$/.exec(value);
  if (!rgb) return;
  const parts = rgb[1].trim().split(/\s*[,/]\s*|\s+/);
  if (parts.length < 3 || parts.length > 4 || parts.some(p => !/^(?:\d+(?:\.\d+)?|\.\d+)%?$/.test(p))) return;
  const channels = parts.map((p,i) => Number(p.replace('%','')) * (p.endsWith('%') ? (i === 3 ? 1 : 255)/100 : 1));
  if (channels.slice(0,3).some(c => c > 255) || (channels[3] ?? 1) > 1) return;
  return [...channels.slice(0,3), channels[3] ?? 1].join(',');
}
const fontKey = (value: string) => value.split(',').map(v => v.trim().replace(/^(['"])(.*)\1$/, '$2').toLowerCase()).join(',');
type ObjectValue = Record<string, any>;
export function variablesFingerprint(variables: Map<string,string>) {
  return createHash('sha256').update(JSON.stringify([[...variables],[...(aliases.get(variables) ?? [])]])).digest('hex');
}
export function mapContextVariables(value: unknown, variables?: Map<string, string>, requestedFile?: string, options?: {maxCandidates: number}): unknown {
  if (!value || typeof value !== 'object') return value;
  const context = value as ObjectValue;
  const colorCandidates = (actual: string) => {
    const key = colorKey(actual);
    return key === undefined ? [] : [...(variables || [])].filter(([name, candidate]) =>
      !aliases.get(variables!)?.has(name) && !name.startsWith('--gos-znak-') && colorKey(candidate) === key).map(([name]) => name);
  };
  const mapLayout = (layout: ObjectValue | undefined, properties: ObjectValue[] = []) => {
    if (!layout?.css) return layout;
    const css = { ...layout.css }, resolvedValues = { ...layout.css }, variableMatching: ObjectValue[] = [];
    if (variables) for (const [property, actual] of Object.entries<string>(resolvedValues)) {
      const group = category(property), color = isColorProperty(property);
      if (!group && !color) {
        variableMatching.push({property, value: actual, candidates: [], status: 'unsupported'});
        continue;
      }
      const match = (part: string) => {
        let comparable = part;
        // A known local font size allows line-height conversion without assuming root/inherited sizes.
        if (property === 'line-height' && /^(?:\d+(?:\.\d+)?|\.\d+)(?:em|%)?$/.test(part) && /^\d+(?:\.\d+)?px$/.test(resolvedValues['font-size'] || '')) {
          comparable = `${parseFloat(part) * parseFloat(resolvedValues['font-size']) / (part.endsWith('%') ? 100 : 1)}px`;
        }
        const candidates = color ? colorCandidates(part) : [...variables].filter(([name,candidate]) => {
          if (!group!.test(name)) return false;
          if (property === 'font-family') {
            const actualFont = fontKey(part), candidateFont = fontKey(candidate);
            return actualFont === candidateFont || (!actualFont.includes(',') && actualFont === candidateFont.split(',')[0]);
          }
          return normalize(candidate) === normalize(comparable);
        }).map(([name]) => name);
        const matched = color ? candidates.length > 0 : candidates.length === 1;
        variableMatching.push({property, value: part, candidates:options ? candidates.slice(0,options.maxCandidates) : candidates, status: matched ? 'matched' : candidates.length ? 'ambiguous' : 'not-found',
          ...(options ? {source:'ui-kit-value-match',candidateCount:candidates.length,candidatesTruncated:candidates.length>options.maxCandidates,
            selectionPolicy:color?'first-literal-color':'unique-category-match',ambiguous:candidates.length>1} : {})});
        return matched ? `var(${candidates[0]})` : part;
      };
      // Do not split functional values (calc, var, rgb) or font stacks.
      const shorthand = /^(padding|margin|gap|inset|border-radius|border-width)$/.test(property);
      if (shorthand && /^[-\d.\s%a-z/]+$/i.test(actual)) css[property] = actual.split(/(\s+|\/)/).map(p => !p.trim() || p === '/' ? p : match(p)).join('');
      else css[property] = match(actual);
    }
    // Colors summary has no CSS role: expose replacements without guessing text vs background.
    const colors = properties.filter(p => p.section === 'colors-inspection-panel').flatMap(p =>
      (p.text || '').split('\n').map((v: string) => v.trim()).filter((v: string) => colorKey(v) !== undefined)
    ).map((actual: string) => {
      const candidates = colorCandidates(actual);
      return {value: actual, cssValue: candidates.length ? `var(${candidates[0]})` : actual, candidates, status: candidates.length ? 'matched' : 'not-found'};
    });
    return { ...layout, css, cssText: Object.entries(css).map(([key, val]) => `${key}: ${val};`).join('\n'), resolvedValues, variableMatching, colors };
  };
  return { ...context, layout: mapLayout(context.layout, context.properties),
    ...(context.nodes ? { nodes: context.nodes.map((node: ObjectValue) => ({ ...node, layout: mapLayout(node.layout, node.properties) })) } : {}),
    ...(requestedFile && context.traversal?.nextRequest ? { traversal: { ...context.traversal, nextRequest: { ...context.traversal.nextRequest, variablesFile: requestedFile } } } : {}) };
}
