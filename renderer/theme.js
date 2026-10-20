// Light/dark for every renderer window. The choice lives in the settings store
// ("theme": system | light | dark); main applies it to nativeTheme.themeSource,
// which drives prefers-color-scheme here — so a change re-themes all windows live.
// Loaded in <head> so the first paint already has the right colours.
(function () {
  const root = document.documentElement;
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  function apply() {
    root.dataset.theme = mq.matches ? "dark" : "light";
  }
  apply();
  mq.addEventListener("change", apply);
})();
