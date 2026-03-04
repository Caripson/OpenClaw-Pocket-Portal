// Minimal i18n helper.
// Default language: English.

const DEFAULT_LANG = 'en';

function detectLang() {
  const url = new URL(location.href);
  const q = (url.searchParams.get('lang') || '').trim().toLowerCase();
  if (q) return q;

  const nav = (navigator.languages && navigator.languages[0]) || navigator.language || DEFAULT_LANG;
  return String(nav).toLowerCase().split('-')[0] || DEFAULT_LANG;
}

export async function loadI18n() {
  const lang = detectLang();
  const tryLangs = [lang, DEFAULT_LANG];

  for (const l of tryLangs) {
    try {
      const res = await fetch(`/static/i18n/${l}.json`, { cache: 'no-store' });
      if (!res.ok) continue;
      const dict = await res.json();
      return { lang: l, t: makeT(dict) };
    } catch {
      // ignore and fallback
    }
  }

  return { lang: DEFAULT_LANG, t: (k, vars) => interpolate(String(k), vars) };
}

function makeT(dict) {
  return (key, vars) => {
    const raw = dict && Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : key;
    return interpolate(String(raw), vars);
  };
}

function interpolate(s, vars) {
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] == null ? `{${k}}` : String(vars[k])));
}

export function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...opts,
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}
