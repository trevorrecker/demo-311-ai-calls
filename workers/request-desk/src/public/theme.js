// Loaded synchronously in <head> so the saved theme applies before first paint.
(() => {
  try {
    const theme = localStorage.getItem("rd311.theme");
    if (theme === "dark" || theme === "light") document.documentElement.dataset.theme = theme;
  } catch { /* storage unavailable: follow the system setting */ }
})();
