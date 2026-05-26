import { nextTick, onBeforeUnmount, onMounted, ref, shallowRef, isRef, watchEffect } from 'vue';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

const XTERM_THEME = {
  background:          '#0f1520',
  foreground:          '#ebe5db',
  cursor:              '#4ade80',
  cursorAccent:        '#0f1520',
  selectionBackground: 'rgba(74,222,128,0.15)',
  black:               '#141b24',
  brightBlack:         '#374558',
  red:                 '#f87171',
  brightRed:           '#fca5a5',
  green:               '#4ade80',
  brightGreen:         '#86efac',
  yellow:              '#fbbf24',
  brightYellow:        '#fde68a',
  blue:                '#60a5fa',
  brightBlue:          '#93c5fd',
  magenta:             '#c084fc',
  brightMagenta:       '#d8b4fe',
  cyan:                '#67e8f9',
  brightCyan:          '#a5f3fc',
  white:               '#c0b9af',
  brightWhite:         '#ebe5db',
};

export function useInteractiveTerminal({ projectId: _projectId, session, getSocket }) {
  const getId = () => isRef(_projectId) ? _projectId.value : _projectId;
  const getS = () => typeof getSocket === 'function' ? getSocket() : getSocket;
  const terminalRef = ref(null);
  const isRunning = ref(false);
  const termInstance = shallowRef(null);
  const fitAddon = shallowRef(null);

  let resizeObserver = null;
  let inputDisposable = null;
  let ptyDataHandler = null;
  let ptyExitHandler = null;

  function emitResize() {
    const term = termInstance.value;
    const socket = getS();
    if (!term || !socket) return;
    socket.emit('pty.resize', {
      project_id: getId(),
      session,
      cols: term.cols,
      rows: term.rows,
    });
  }

  function fit() {
    requestAnimationFrame(() => {
      fitAddon.value?.fit();
      emitResize();
    });
  }

  function attachTerminal(el) {
    const term = termInstance.value;
    if (!term || !el) return;
    el.innerHTML = '';
    if (term.element) {
      el.appendChild(term.element);
    } else {
      term.open(el);
    }
    requestAnimationFrame(() => fitAddon.value?.fit());

    resizeObserver?.disconnect();
    resizeObserver = new ResizeObserver(() => fit());
    resizeObserver.observe(el);
  }

  function bindSocketListeners() {
    const socket = getS();
    if (!socket) return;

    ptyDataHandler = ({ project_id, session: s, data }) => {
      if (project_id !== getId() || s !== session) return;
      termInstance.value?.write(data);
    };

    ptyExitHandler = ({ project_id, session: s }) => {
      if (project_id !== getId() || s !== session) return;
      isRunning.value = false;
      termInstance.value?.write('\r\n\x1b[90m[process exited]\x1b[0m\r\n');
    };

    socket.on('pty.data',  ptyDataHandler);
    socket.on('pty.exit',  ptyExitHandler);
  }

  function unbindSocketListeners() {
    const socket = getS();
    if (!socket) return;
    if (ptyDataHandler) socket.off('pty.data',  ptyDataHandler);
    if (ptyExitHandler) socket.off('pty.exit',  ptyExitHandler);
  }

  function markRunning() {
    isRunning.value = true;
    nextTick(() => {
      fit();
      // Send a second resize after Pi has had time to initialize and respond to SIGWINCH
      setTimeout(() => fit(), 300);
    });
  }

  function markStopped() {
    isRunning.value = false;
  }

  onMounted(() => {
    const terminal = new Terminal({
      convertEol: false,
      scrollback: 10000,
      fontSize: 12,
      fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", monospace',
      lineHeight: 1.4,
      letterSpacing: 0.3,
      cursorBlink: true,
      disableStdin: false,
      theme: XTERM_THEME,
    });

    const fit = new FitAddon();
    terminal.loadAddon(fit);
    termInstance.value = terminal;
    fitAddon.value = fit;

    inputDisposable = terminal.onData(data => {
      const socket = getS();
      if (!isRunning.value || !socket) return;
      socket.emit('pty.input', { project_id: getId(), session, data });
    });

    // Re-bind listeners whenever socket becomes available (reactive)
    watchEffect(() => {
      unbindSocketListeners();
      bindSocketListeners();
    });

    nextTick(() => {
      if (terminalRef.value) attachTerminal(terminalRef.value);
    });
  });

  onBeforeUnmount(() => {
    resizeObserver?.disconnect();
    inputDisposable?.dispose();
    unbindSocketListeners();
    termInstance.value?.dispose();
  });

  return {
    terminalRef,
    isRunning,
    markRunning,
    markStopped,
    fit,
  };
}
