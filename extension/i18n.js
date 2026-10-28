// Chrome chooses the UI locale and falls back to manifest.default_locale.
export function t(key, substitutions = []) {
  return chrome.i18n.getMessage(key, substitutions);
}

export function localizeDocument(document) {
  document.documentElement.lang = /^ru(?:-|$)/i.test(chrome.i18n.getUILanguage()) ? 'ru' : 'en';
  for (const element of document.querySelectorAll('[data-i18n]')) {
    element.textContent = t(element.dataset.i18n);
  }
  for (const attribute of ['placeholder', 'aria-label']) {
    const marker = `data-i18n-${attribute}`;
    for (const element of document.querySelectorAll(`[${marker}]`)) {
      element.setAttribute(attribute, t(element.getAttribute(marker)));
    }
  }
}
