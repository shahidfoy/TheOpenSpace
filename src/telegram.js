// Thin wrapper over the Telegram Mini App SDK. Everything degrades gracefully in a normal browser.
export const tg = window.Telegram?.WebApp;
export const inTelegram = !!(tg && tg.initData);
const atLeast = (v) => !!tg?.isVersionAtLeast?.(v);

export function initTelegram() {
  if (!tg) return;
  try {
    tg.ready();
    tg.expand();
    if (atLeast('7.7')) tg.disableVerticalSwipes();
    if (atLeast('6.1')) { tg.setHeaderColor('#05060a'); tg.setBackgroundColor('#05060a'); }
  } catch {}
}

export function haptic(kind = 'light') {
  try { if (atLeast('6.1')) tg.HapticFeedback.impactOccurred(kind); } catch {}
}
export function notify(kind = 'success') {
  try { if (atLeast('6.1')) tg.HapticFeedback.notificationOccurred(kind); } catch {}
}

export function backButton(show, onClick) {
  if (!tg?.BackButton || !atLeast('6.1')) return;
  tg.BackButton.offClick(backButton._cb || (() => {}));
  if (show) { backButton._cb = onClick; tg.BackButton.onClick(onClick); tg.BackButton.show(); }
  else tg.BackButton.hide();
}

// CloudStorage values are limited to 4096 chars, so saves are chunked across keys.
const canCloud = () => inTelegram && tg.CloudStorage && atLeast('6.9');
const CHUNK = 3800;
export function cloudSave(json) {
  if (!canCloud()) return;
  const n = Math.ceil(json.length / CHUNK);
  for (let i = 0; i < n; i++) tg.CloudStorage.setItem(`save_${i}`, json.slice(i * CHUNK, (i + 1) * CHUNK));
  tg.CloudStorage.setItem('save_n', String(n));
}
export function cloudLoad() {
  return new Promise((resolve) => {
    if (!canCloud()) return resolve(null);
    setTimeout(() => resolve(null), 2500);
    tg.CloudStorage.getItem('save_n', (err, v) => {
      const n = parseInt(v, 10);
      if (err || !n) return resolve(null);
      const keys = Array.from({ length: n }, (_, i) => `save_${i}`);
      tg.CloudStorage.getItems(keys, (e2, vals) => {
        if (e2) return resolve(null);
        try { resolve(JSON.parse(keys.map((k) => vals[k]).join(''))); } catch { resolve(null); }
      });
    });
  });
}
export function cloudWipe() {
  if (canCloud()) tg.CloudStorage.setItem('save_n', '0');
}
