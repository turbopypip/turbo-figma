// Runs briefly in MAIN to receive the public download produced by Figma's Export
// button, including a detached <a download>. Does not inspect Figma's runtime.
export function installDownloadCapture(marker, fileKey, format = 'SVG', scale = 1) {
  if (location.origin !== 'https://www.figma.com' || location.pathname.split('/')[2] !== fileKey) throw new Error('Paired file changed');
  if (!['PNG', 'SVG'].includes(format) || !Number.isFinite(scale) || scale < 0.1 || scale > 2) throw new Error('Invalid native export options');
  const limit = (format === 'PNG' ? 12 : 3) * 1024 * 1024;
  const key = '__turboFigmaNativeDownload';
  globalThis[key]?.dispose();
  const prototype = HTMLAnchorElement.prototype;
  const original = prototype.click;
  const state = { marker, result: null, error: null, started: false };
  const controller = new AbortController();
  let timer;
  const restore = () => {
    if (prototype.click === intercept) prototype.click = original;
    window.removeEventListener('click', onClick, true);
  };
  state.dispose = () => { restore(); clearTimeout(timer); controller.abort(); if (globalThis[key] === state) delete globalThis[key]; };
  async function receive(anchor) {
    state.started = true;
    restore();
    try {
      const response = await fetch(anchor.href, { credentials: 'omit', signal: controller.signal });
      const reader = response.body.getReader();
      const chunks = []; let length = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read(); if (done) break;
          length += value.length;
          if (length > limit) throw new Error('Native export exceeds size limit. Select a smaller layer.');
          chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => {}); }
      let bytes = new Uint8Array(length); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      if (/\.zip$/i.test(anchor.download)) {
        const view = new DataView(bytes.buffer);
        let end = bytes.length - 22;
        while (end >= Math.max(0, bytes.length - 65557) && view.getUint32(end, true) !== 0x06054b50) end--;
        if (end < 0 || view.getUint16(end + 10, true) !== 1 || view.getUint16(end + 4, true) !== 0)
          throw new Error('Expected a ZIP containing exactly one asset.');
        const central = view.getUint32(end + 16, true);
        if (view.getUint32(central, true) !== 0x02014b50) throw new Error('Invalid ZIP directory');
        const method = view.getUint16(central + 10, true), size = view.getUint32(central + 24, true);
        const compressed = view.getUint32(central + 20, true), local = view.getUint32(central + 42, true);
        const nameLength = view.getUint16(central + 28, true);
        const name = new TextDecoder().decode(bytes.subarray(central + 46, central + 46 + nameLength));
        if (!name.toLowerCase().endsWith('.' + format.toLowerCase()) || size > limit || (view.getUint16(central + 8, true) & 1))
          throw new Error('ZIP must contain one unencrypted asset within the size limit.');
        if (view.getUint32(local, true) !== 0x04034b50) throw new Error('Invalid ZIP entry');
        const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
        if (start + compressed > central) throw new Error('Invalid ZIP size');
        const payload = bytes.slice(start, start + compressed);
        if (method === 0) bytes = payload;
        else if (method === 8) {
          const stream = new Blob([payload]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
          const reader = stream.getReader(), chunks = []; let total = 0;
          try {
            for (;;) {
              const { value, done } = await reader.read(); if (done) break;
              total += value.length;
              if (total > limit) throw new Error('Decompressed export exceeds size limit.');
              chunks.push(value);
            }
          } finally { await reader.cancel().catch(() => {}); }
          bytes = new Uint8Array(total); let offset = 0;
          for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        } else throw new Error('Unsupported ZIP compression');
        if (bytes.length !== size) throw new Error('Export size does not match ZIP metadata');
      }
      if (format === 'PNG') {
        if (bytes.length < 24 || ![137,80,78,71,13,10,26,10].every((v,i) => bytes[i] === v)) throw new Error('Invalid native PNG');
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const width = view.getUint32(16), height = view.getUint32(20);
        if (!width || !height || width * height > 16_000_000) throw new Error('Source PNG exceeds 16 megapixels');
        const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
        try {
          const applied = Math.min(scale, 2048 / Math.max(width, height));
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(width * applied)); canvas.height = Math.max(1, Math.round(height * applied));
          canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
          const data = canvas.toDataURL('image/png').split(',')[1];
          if (data.length > 4 * 1024 * 1024) throw new Error('PNG exceeds 3 MiB');
          state.result = { data, scale: applied, scaleBasis: 'native-export' };
          return;
        } finally { bitmap.close(); }
      }
      if (!/<svg[\s>]/.test(new TextDecoder().decode(bytes))) throw new Error('Figma download is not an SVG');
      let binary = ''; for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      state.result = { data: btoa(binary) };
    } catch (error) { state.error = error.message || 'Could not receive native download'; }
  }
  const matches = anchor => !state.started && anchor instanceof HTMLAnchorElement &&
    anchor.href.startsWith('blob:https://www.figma.com/') && (anchor.download.toLowerCase().endsWith('.' + format.toLowerCase()) || /\.zip$/i.test(anchor.download));
  function intercept(...args) {
    if (matches(this)) { void receive(this); return; }
    return original.apply(this, args);
  }
  function onClick(event) {
    const anchor = event.target?.closest?.('a[download]');
    if (!matches(anchor)) return;
    event.preventDefault(); event.stopImmediatePropagation(); void receive(anchor);
  }
  globalThis[key] = state;
  prototype.click = intercept;
  window.addEventListener('click', onClick, true);
  timer = setTimeout(() => state.dispose(), 25000);
}

export function readDownloadCapture(marker, fileKey, dispose = false) {
  const state = globalThis.__turboFigmaNativeDownload;
  if (!state || state.marker !== marker) return { error: 'Native export capture expired' };
  if (dispose) { state.dispose(); return null; }
  if (location.origin !== 'https://www.figma.com' || location.pathname.split('/')[2] !== fileKey) {
    state.dispose(); return { error: 'Paired file changed during download' };
  }
  if (state.error) { const error = state.error; state.dispose(); return { error }; }
  if (!state.result) return null;
  const result = state.result; state.dispose(); return result;
}
