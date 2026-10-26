// Keep virtualized DOM and menus rendering without activating a tab or OS window.
// Reuse the capture debugger; a temporary attachment is used for export-only sessions.
export async function withBackgroundRendering(chrome, tabId, attached, work) {
  if (!chrome.debugger) throw new Error('Background export requires the debugger permission.');
  const target = { tabId };
  let owned = false;
  try {
    if (!attached) { await chrome.debugger.attach(target, '1.3'); owned = true; }
    await chrome.debugger.sendCommand(target, 'Emulation.setFocusEmulationEnabled', { enabled: true });
    return await work();
  } finally {
    if (owned || attached) try {
      await chrome.debugger.sendCommand(target, 'Emulation.setFocusEmulationEnabled', { enabled: false });
    } finally {
      if (owned) await chrome.debugger.detach(target);
    }
  }
}
