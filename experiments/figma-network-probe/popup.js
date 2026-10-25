const status = document.querySelector('#status');
async function call(action) {
  const result = await chrome.runtime.sendMessage({ action });
  if (!result?.ok) throw new Error(result?.error || 'Нет ответа от сборщика');
  return result.data;
}
async function refresh() { status.textContent = JSON.stringify(await call('status'), null, 2); }
for (const action of ['start', 'stop', 'save', 'clear']) {
  document.querySelector(`#${action}`).onclick = async () => {
    try {
      if (action === 'save') {
        const dump = await call('export');
        const url = URL.createObjectURL(new Blob([JSON.stringify(dump)], { type: 'application/json' }));
        const a = document.createElement('a');
        a.href = url; a.download = `figma-probe-${Date.now()}.json`; a.click();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
      } else { await call(action); }
      await refresh();
    } catch (error) { status.textContent = error.message; }
  };
}
refresh().catch(error => { status.textContent = error.message; });
