export function registerPwa(): void {
  if (!window.isSecureContext || !('serviceWorker' in navigator)) return;

  const register = () => {
    const worker = new URL('/sw.js', window.location.origin);
    void navigator.serviceWorker.register(worker.href, {
      scope: '/',
      updateViaCache: 'none',
    }).catch(() => {});
  };

  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}
