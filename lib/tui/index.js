'use strict';

/**
 * Renders a searchable Pi TUI menu and resolves to the chosen item's value.
 * Returns 'exit' on Escape / Ctrl+C / cancel.
 *
 * Layout:
 *   > <search input with cursor>
 *   ── filtered SelectList ──────
 *
 * @param {Array<{value: string, label: string, description?: string}>} menuItems
 * @returns {Promise<string>}
 */
async function runJonggrangTUI(menuItems) {
  const { TUI, ProcessTerminal, SelectList, Input } = await import('@earendil-works/pi-tui');

  const terminal = new ProcessTerminal();

  const theme = {
    selectedPrefix: (text) => `\x1b[36m${text}\x1b[0m`,
    selectedText:   (text) => `\x1b[1m${text}\x1b[0m`,
    description:    (text) => `\x1b[2m${text}\x1b[0m`,
    scrollInfo:     (text) => `\x1b[2m${text}\x1b[0m`,
    noMatch:        (text) => `\x1b[2m${text}\x1b[0m`,
  };

  return new Promise((resolve) => {
    const input = new Input();
    input.focused = true; // so Input emits CURSOR_MARKER for hardware cursor positioning

    const list = new SelectList(menuItems, 12, theme);

    list.onSelect = (item) => {
      tui.stop();
      resolve(item.value);
    };

    list.onCancel = () => {
      tui.stop();
      resolve('exit');
    };

    // Combined search + list component that TUI treats as a single focusable child.
    // Routes navigation keys (↑↓ Enter) to the list, everything else to the input.
    // Calls list.setFilter() after every keystroke so the list stays in sync.
    const searchable = {
      focused: true,

      render(width) {
        // "> " prefix + input (contains CURSOR_MARKER when input.focused = true)
        const prefix = '\x1b[36m>\x1b[0m ';
        const inputLines = input.render(Math.max(1, width - 2));
        return [
          prefix + (inputLines[0] || ''),
          ...list.render(width),
        ];
      },

      handleInput(data) {
        const up    = data === '\x1b[A';
        const down  = data === '\x1b[B';
        const enter = data === '\r' || data === '\n';
        const esc   = data === '\x1b';
        const ctrlC = data === '\x03';

        if (up || down || enter) {
          list.handleInput(data);
        } else if (esc || ctrlC) {
          tui.stop();
          resolve('exit');
        } else {
          input.handleInput(data);
          list.setFilter(input.getValue());
        }
      },

      invalidate() {
        input.invalidate();
        list.invalidate();
      },
    };

    const tui = new TUI(terminal);
    tui.addChild(searchable);
    tui.setFocus(searchable);
    tui.start();
  });
}

module.exports = { runJonggrangTUI };
