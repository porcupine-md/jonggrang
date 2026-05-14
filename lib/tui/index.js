'use strict';

/**
 * Renders a Pi TUI SelectList menu and resolves to the chosen item's value.
 * Returns 'exit' on Escape/cancel.
 *
 * @param {Array<{value: string, label: string, description?: string}>} menuItems
 * @returns {Promise<string>}
 */
async function runJonggrangTUI(menuItems) {
  const { TUI, ProcessTerminal, SelectList } = await import('@earendil-works/pi-tui');

  const terminal = new ProcessTerminal();

  const theme = {
    selectedPrefix: (text) => `\x1b[36m${text}\x1b[0m`,
    selectedText:   (text) => `\x1b[1m${text}\x1b[0m`,
    description:    (text) => `\x1b[2m${text}\x1b[0m`,
    scrollInfo:     (text) => `\x1b[2m${text}\x1b[0m`,
    noMatch:        (text) => `\x1b[2m${text}\x1b[0m`,
  };

  return new Promise((resolve) => {
    const list = new SelectList(menuItems, 12, theme);

    list.onSelect = (item) => {
      tui.stop();
      resolve(item.value);
    };

    list.onCancel = () => {
      tui.stop();
      resolve('exit');
    };

    const tui = new TUI(terminal);
    tui.addChild(list);
    tui.setFocus(list);
    tui.start();
  });
}

module.exports = { runJonggrangTUI };
