import { ref, watch } from 'vue';

const STORAGE_KEY = 'jonggrang-theme';

// Singleton state — shared across all useTheme() calls
const mode = ref(localStorage.getItem(STORAGE_KEY) || 'night');

function apply(m) {
  const html = document.documentElement;
  if (m === 'night') {
    html.classList.add('dark');
  } else if (m === 'light') {
    html.classList.remove('dark');
  } else {
    // system
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    html.classList.toggle('dark', prefersDark);
  }
}

// Re-apply when OS preference changes (only matters in 'system' mode)
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (mode.value === 'system') apply('system');
});

// Apply immediately on load
apply(mode.value);

export function useTheme() {
  function setMode(m) {
    mode.value = m;
    localStorage.setItem(STORAGE_KEY, m);
    apply(m);
  }

  return { mode, setMode };
}
