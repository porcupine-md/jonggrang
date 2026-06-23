'use strict';

// lib/tui.js — Jonggrang TUI using @earendil-works/pi-tui
//
// Exports:
//   runJonggrangTUI(items)        simple select dialog (login, logout, model)
//   runJonggrangApp(opts)         full-screen menu TUI with inline plan input

const fs   = require('fs');
const path = require('path');

// Cache for filesystem reads shown in the status line. The TUI re-renders on
// every input event — without this we'd read every feature's tasks file on
// every keystroke. TTL is short enough that active work feels live.
const STATUS_CACHE_TTL_MS = 1500;

// ── ANSI helpers ──────────────────────────────────────────────────────────────
const b  = s => `\x1b[1m${s}\x1b[22m`;
const d  = s => `\x1b[2m${s}\x1b[22m`;
const cy = s => `\x1b[36m${s}\x1b[39m`;
const yw = s => `\x1b[33m${s}\x1b[39m`;

// ── Simple select dialog ──────────────────────────────────────────────────────
// Used by cmdLogin, cmdLogout, cmdModel, and cmdMenuTUI (legacy fallback)
// Returns Promise<string|null>
async function runJonggrangTUI(items) {
  const { TUI, ProcessTerminal, SelectList, Text } = await import('@earendil-works/pi-tui');
  const { getSelectListTheme, initTheme } = await import('@earendil-works/pi-coding-agent');
  initTheme();

  return new Promise((resolve) => {
    const terminal = new ProcessTerminal();
    const tui = new TUI(terminal);

    const slTheme = getSelectListTheme();
    const selectList = new SelectList(items, Math.min(items.length + 1, 16), slTheme);
    selectList.onSelect = (item) => { tui.stop(); resolve(item.value); };
    selectList.onCancel = () => { tui.stop(); resolve(null); };

    tui.addChild(new Text(`${b(cy(' JONGGRANG'))}  ${d('AI Development Orchestrator')}`, 0, 1));
    tui.addChild(selectList);
    tui.addChild({
      render: () => ['', d(' ↑↓ navigate  Enter select  / filter  Esc exit')],
      invalidate: () => {},
    });
    tui.setFocus(selectList);
    tui.start();
  });
}

// ── Full-screen menu TUI ──────────────────────────────────────────────────────
// Persistent TUI — does not tear down between actions.
// Handles plan-description input inline (no @clack/prompts teardown).
//
// opts: { items: SelectItem[], projectRoot: string }
// Returns Promise<{ choice: string|null, planDescription?: string }>
async function runJonggrangApp({ items, projectRoot }) {
  const { TUI, ProcessTerminal, SelectList, Input, Text } = await import('@earendil-works/pi-tui');
  const { getSelectListTheme, initTheme } = await import('@earendil-works/pi-coding-agent');
  initTheme();

  return new Promise((resolve) => {
    const terminal = new ProcessTerminal();
    const tui = new TUI(terminal);
    let mode = 'menu'; // 'menu' | 'plan-input'
    let statusCache = { at: 0, drafts: null, summary: null };

    function readDraftCount() {
      if (!projectRoot) return 0;
      const dir = path.join(projectRoot, '.jonggrang', '.drafts');
      if (!fs.existsSync(dir)) return 0;
      try {
        return fs.readdirSync(dir).filter(name =>
          fs.existsSync(path.join(dir, name, 'plan.md'))
        ).length;
      } catch { return 0; }
    }

    // Read merged task counts across all feature files (status line only).
    function readTaskSummary() {
      if (!projectRoot) return null;
      const featuresDir = path.join(projectRoot, '.jonggrang', '.output', 'features');
      if (!fs.existsSync(featuresDir)) return null;
      let total = 0, done = 0;
      for (const name of fs.readdirSync(featuresDir)) {
        const p = path.join(featuresDir, name, 'jonggrang-tasks.json');
        if (!fs.existsSync(p)) continue;
        try {
          const { tasks = [] } = JSON.parse(fs.readFileSync(p, 'utf8'));
          total += tasks.length;
          done += tasks.filter(t => t.status === 'completed').length;
        } catch {}
      }
      return total > 0 ? { total, done } : null;
    }

    // ── Project status summary ─────────────────────────────────────────────────
    function statusLine() {
      const now = Date.now();
      if (now - statusCache.at > STATUS_CACHE_TTL_MS) {
        statusCache = { at: now, drafts: readDraftCount(), summary: readTaskSummary() };
      }
      const parts = [];
      if (statusCache.drafts > 0) {
        const n = statusCache.drafts;
        parts.push(yw(`● ${n} draft${n > 1 ? 's' : ''} pending`));
      }
      if (statusCache.summary) parts.push(d(`${statusCache.summary.done}/${statusCache.summary.total} tasks`));
      return parts.join('  ');
    }

    // ── Header (always visible) ────────────────────────────────────────────────
    tui.addChild({
      render: (width) => {
        const st = statusLine();
        return [
          '',
          `${b(cy(' ❯ JONGGRANG'))}  ${d('AI Development Orchestrator')}${st ? `  ${st}` : ''}`,
          d('─'.repeat(Math.max(0, width - 2))),
          '',
        ];
      },
      invalidate: () => {},
    });

    // ── Menu select list ───────────────────────────────────────────────────────
    const slTheme = getSelectListTheme();
    const selectList = new SelectList(items, Math.min(items.length + 1, 14), slTheme);

    selectList.onSelect = (item) => {
      if (item.value === 'plan') {
        mode = 'plan-input';
        planInput.setValue('');
        tui.setFocus(planInput);
        tui.requestRender(true);
        return;
      }
      tui.stop();
      resolve({ choice: item.value });
    };
    selectList.onCancel = () => {
      tui.stop();
      resolve({ choice: null });
    };

    // Conditional wrapper — renders selectList only in menu mode
    tui.addChild({
      render: (w) => mode === 'menu' ? selectList.render(w) : [],
      invalidate: () => selectList.invalidate(),
    });
    tui.addChild({
      render: () => mode === 'menu'
        ? ['', d(' ↑↓ navigate  Enter select  / filter  Esc exit')]
        : [],
      invalidate: () => {},
    });

    // ── Plan input ─────────────────────────────────────────────────────────────
    const planInput = new Input();
    planInput.onSubmit = (value) => {
      const trimmed = value.trim();
      if (!trimmed) return;
      tui.stop();
      resolve({ choice: 'plan', planDescription: trimmed });
    };
    planInput.onEscape = () => {
      mode = 'menu';
      tui.setFocus(selectList);
      tui.requestRender(true);
    };

    tui.addChild({
      render: () => mode === 'plan-input' ? [
        d(' Plan a new feature — Phase 1'),
        d(' ──────────────────────────────'),
        '',
        d(' Feature description:'),
      ] : [],
      invalidate: () => {},
    });

    // Focusable proxy — propagates `focused` to planInput so cursor marker works
    tui.addChild({
      get focused() { return planInput.focused; },
      set focused(v) { planInput.focused = v; },
      render: (w) => mode === 'plan-input' ? planInput.render(w) : [],
      handleInput: (data) => planInput.handleInput(data),
      invalidate: () => planInput.invalidate(),
    });

    tui.addChild({
      render: () => mode === 'plan-input'
        ? ['', d(' Enter to confirm  Esc to go back')]
        : [],
      invalidate: () => {},
    });

    tui.setFocus(selectList);
    tui.start();
  });
}

module.exports = { runJonggrangTUI, runJonggrangApp };
