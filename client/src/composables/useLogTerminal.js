import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

const XTERM_THEME = {
  background: '#0a0b0f',
  foreground: '#e2e4e9',
  cursor: '#38bdf8',
  cursorAccent: '#0a0b0f',
  selectionBackground: 'rgba(56,189,248,0.2)',
  black: '#1a1b22',
  brightBlack: '#4a4d5e',
  red: '#f87171',
  brightRed: '#fca5a5',
  green: '#4ade80',
  brightGreen: '#86efac',
  yellow: '#facc15',
  brightYellow: '#fde047',
  blue: '#60a5fa',
  brightBlue: '#93c5fd',
  magenta: '#c084fc',
  brightMagenta: '#d8b4fe',
  cyan: '#22d3ee',
  brightCyan: '#67e8f9',
  white: '#e2e4e9',
  brightWhite: '#f8fafc',
};

export function useLogTerminal(logs) {
  const logContainerRef = ref(null);
  const terminalInstance = shallowRef(null);
  const fitAddon = shallowRef(null);
  const logContentLength = ref(0);
  const hasLogs = computed(() => logs.value.length > 0);
  const logLineCount = ref(0);

  let resizeObserver = null;
  let windowResizeHandler = null;

  function fitTerminal() {
    requestAnimationFrame(() => fitAddon.value?.fit());
  }

  function renderFullLog() {
    const term = terminalInstance.value;
    if (!term) return;

    term.clear();
    logContentLength.value = logs.value.length;
    logLineCount.value = logs.value ? logs.value.split('\n').length : 0;
    if (!logs.value) return;

    term.write(logs.value.replace(/\r?\n/g, '\r\n'));
    term.scrollToBottom();
  }

  function attachTerminal(el) {
    const term = terminalInstance.value;
    if (!term || !el) return;

    el.innerHTML = '';
    if (term.element) {
      el.appendChild(term.element);
    } else {
      term.open(el);
    }

    requestAnimationFrame(() => {
      fitAddon.value?.fit();
      renderFullLog();
    });

    resizeObserver?.disconnect();
    resizeObserver = new ResizeObserver(() => fitTerminal());
    resizeObserver.observe(el);
  }

  function clearTerminal() {
    logContentLength.value = 0;
    logLineCount.value = 0;
    terminalInstance.value?.clear();
  }

  watch(logContainerRef, (element) => {
    if (element && terminalInstance.value) {
      nextTick(() => attachTerminal(element));
    }
  }, { flush: 'post' });

  watch(logs, (nextLogs) => {
    const term = terminalInstance.value;
    const container = logContainerRef.value;
    if (!term || !container) return;

    if (!term.element || !container.contains(term.element)) {
      attachTerminal(container);
      return;
    }

    if (nextLogs.length < logContentLength.value) {
      renderFullLog();
      return;
    }

    const diff = nextLogs.slice(logContentLength.value);
    if (!diff) return;

    const newlineCount = (diff.match(/\n/g) || []).length;
    logLineCount.value += newlineCount + (logLineCount.value === 0 ? 1 : 0);
    term.write(diff.replace(/\r?\n/g, '\r\n'));
    logContentLength.value = nextLogs.length;
    term.scrollToBottom();
  }, { flush: 'post' });

  onMounted(() => {
    const terminal = new Terminal({
      convertEol: true,
      scrollback: 10000,
      fontSize: 12,
      fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", monospace',
      lineHeight: 1.4,
      letterSpacing: 0.3,
      theme: XTERM_THEME,
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);

    terminalInstance.value = terminal;
    fitAddon.value = fit;
    windowResizeHandler = () => fitTerminal();
    window.addEventListener('resize', windowResizeHandler);

    nextTick(() => {
      if (logContainerRef.value) {
        attachTerminal(logContainerRef.value);
      }
    });
  });

  onBeforeUnmount(() => {
    if (windowResizeHandler) {
      window.removeEventListener('resize', windowResizeHandler);
      windowResizeHandler = null;
    }

    resizeObserver?.disconnect();
    resizeObserver = null;
    terminalInstance.value?.dispose();
  });

  return {
    logContainerRef,
    hasLogs,
    logLineCount,
    clearTerminal,
  };
}
