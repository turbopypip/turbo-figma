const states = {
  connected: { text: 'ON', color: '#167541', title: 'Подключено к MCP' },
  busy: { text: 'RUN', color: '#2459a6', title: 'Выполняется запрос' },
  connecting: { text: '…', color: '#a66b00', title: 'Подключение / ожидание восстановления связи' },
  disconnected: { text: 'OFF', color: '#666666', title: 'Отключено — открой подключение значком на вкладке Figma' },
  stale: { text: '!', color: '#b63030', title: 'Сетевой снимок устарел — открой состояние захвата' },
  error: { text: '!', color: '#b63030', title: 'Подключение отклонено — проверь ключ или другое соединение' },
};

export function createStatusBadge(chrome) {
  let work = Promise.resolve();
  return state => {
    const value = states[state];
    if (!value) return work;
    work = work.catch(() => {}).then(async () => {
      await chrome.action.setBadgeBackgroundColor({ color: value.color });
      await chrome.action.setBadgeText({ text: value.text });
      await chrome.action.setTitle({ title: `Figma ↔ Kilo CLI: ${value.title}` });
    });
    work.catch(() => {});
    return work;
  };
}
