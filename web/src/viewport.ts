export function syncDisplayMode() {
  const standalone = matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches || Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
  document.documentElement.toggleAttribute('data-standalone', standalone);
  return standalone;
}
