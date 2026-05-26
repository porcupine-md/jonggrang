# Adding a New Agent Tool to Jonggrang

This guide covers every file and function you must touch to integrate a new AI agent backend into jonggrang. The three existing backends — `claude` (CLI spawn), `opencode` (CLI spawn with JSON streaming), and `jonggrang` (Pi SDK, in-process) — serve as reference implementations.

---

## Two Backend Patterns

Before starting, decide which pattern fits your tool:

| Pattern | When to use | Examples |
|---------|-------------|---------|
| **CLI spawn** | Tool is a standalone binary invoked via command line | `claude`, `opencode` |
| **SDK in-process** | Tool is an npm package used as a library inside jonggrang's Node process | `jonggrang` (Pi SDK) |

CLI spawn is simpler. SDK in-process gives tighter integration (event streaming, no extra process) but requires the SDK to be compatible with Node's dynamic `import()` from CJS.

---

## Checklist

```
lib/backend-args.js          — flag translation (1 case block)
lib/jonggrang.js             — 4 locations
  resolveSkillsDir()         — skills path for this tool
  runAgent()                 — spawn / SDK logic
  generateConfig()           — skills.directory default
  runInit() skillTargets     — install skills on init
lib/hooks.js                 — hook installer (optional)
bin/jonggrang.js             — 5 locations
  checkDeps()                — binary / SDK presence check
  checkDeps() switch         — install hint message
  cmdInit() select()         — interactive tool picker
  cmdInit() ask() fallback   — non-interactive tool picker
  cmdHelp()                  — help text + examples
hooks/<mytool>/              — hook scripts (optional)
test/backend-args.test.js    — test cases
docs/CONFIG.md               — backend mapping table
docs/WORKFLOW.md             — example commands
README.md                    — requirements, examples
```

---

## 1. `lib/backend-args.js`

**Function:** `buildAgentArgs({ tool, model, effort }) → string[]`

Translates jonggrang's generic `--model` and `--effort` flags into the backend-specific argv fragment spliced into the spawn command. For SDK backends that resolve model internally, return `[]`.

```js
// CLI spawn example — tool has --model and --thinking flags
case 'mytool':
  if (model) flags.push('--model', model);
  if (effort) flags.push('--thinking', effort);   // rename effort flag as needed
  break;

// SDK in-process example — flags are handled inside runAgent()
case 'mytool':
  break;   // returns []
```

For CLI backends that require a specific model format (e.g. OpenCode's `provider/model`), throw a descriptive error here:

```js
case 'mytool':
  if (model && !model.includes('/')) {
    throw new Error(
      `mytool requires provider/model format (e.g. myprovider/my-model-id). ` +
      `Got: "${model}".`
    );
  }
  if (model) flags.push('--model', model);
  break;
```

---

## 2. `lib/jonggrang.js`

### 2a. `resolveSkillsDir(projectRoot, tool)` — line ~16

Returns the directory where jonggrang installs skill files for this tool. Skills are `.md` files that the agent can invoke.

```js
function resolveSkillsDir(projectRoot, tool) {
  if (tool === 'claude')    return path.join(projectRoot, '.claude', 'skills');
  if (tool === 'opencode')  return path.join(projectRoot, '.opencode', 'skills');
  if (tool === 'jonggrang') return path.join(projectRoot, '.jonggrang', 'skills');
  if (tool === 'mytool')    return path.join(projectRoot, '.mytool', 'skills');   // ADD
  return path.join(projectRoot, 'skills');
}
```

Use the convention `.toolname/skills/` to keep the project root clean.

---

### 2b. `runAgent(prompt, tool, permMode, projectRoot, options)` — line ~815

The core backend dispatcher. Add an `else if` branch **before** the final `else { resolve(1); }`.

**CLI spawn template:**

```js
} else if (tool === 'mytool') {
  // mytool CLI — spawned as: mytool [flags] <prompt>
  const args = [...extraFlags, prompt];

  const child = spawn('mytool', args, {
    cwd: projectRoot,
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  child.on('close', (code) => resolve(code || 0));
```

**CLI spawn with JSON streaming** (like opencode — parses structured output):

```js
} else if (tool === 'mytool') {
  const child = spawn('mytool', ['run', '--format', 'json', ...extraFlags, prompt], {
    cwd: projectRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        // handle event.type, event.content, etc.
      } catch { process.stdout.write(line + '\n'); }
    }
  });
  child.stderr.on('data', (d) => process.stderr.write(d));
  child.on('close', (code) => resolve(code || 0));
```

**SDK in-process template** (like jonggrang/Pi SDK — ESM packages need dynamic import):

```js
} else if (tool === 'mytool') {
  // mytool uses the @myorg/mytool-sdk npm package directly (ESM-only → dynamic import)
  (async () => {
    try {
      const { createSession } = await import('@myorg/mytool-sdk');

      const session = await createSession({
        cwd: projectRoot,
        ...(model ? { model } : {}),
        ...(effort ? { thinkingLevel: effort } : {}),
      });

      session.on('text', (delta) => process.stdout.write(delta));

      await session.prompt(prompt);
      resolve(0);
      process.exit(0);   // force-exit if SDK holds async handles open
    } catch (err) {
      process.stderr.write(`[mytool] error: ${err.message}\n`);
      resolve(1);
      process.exit(1);
    }
  })();
```

> **Note on `process.exit(0)`:** SDK backends that keep async handles alive (HTTP connections, timers) after `prompt()` resolves must call `process.exit()` to unblock the parent `spawnSync` call in the work loop. CLI spawn backends must NOT call `process.exit()`.

> **`permMode` parameter:** For claude, `permMode` controls the `--dangerously-skip-permissions` / `--allowedTools` flags. If your tool has a similar concept, apply it here. Otherwise ignore it.

---

### 2c. `generateConfig(options)` — line ~1238

The `skills.directory` field in `jonggrang.json` points to the active tool's skills folder. Update the ternary:

```js
// Before (only two cases):
directory: tool === 'opencode' ? './.opencode/skills' : './.claude/skills',

// After (add your tool):
directory: tool === 'opencode' ? './.opencode/skills'
         : tool === 'mytool'   ? './.mytool/skills'
         : './.claude/skills',
```

---

### 2d. `runInit()` — `skillTargets` array — line ~1389

jonggrang copies all skills into every tool's directory at `jonggrang init` time so switching tools doesn't break skill access. Add your tool's skills path:

```js
const skillTargets = [
  path.join(projectRoot, '.claude', 'skills'),
  path.join(projectRoot, '.opencode', 'skills'),
  path.join(projectRoot, '.jonggrang', 'skills'),
  path.join(projectRoot, '.mytool', 'skills'),   // ADD
];
```

---

## 3. `lib/hooks.js`

jonggrang has a **universal hook layer** that maps abstract hook events to tool-specific mechanisms. The `EVENT_MAP` at line 15 defines the mapping:

```js
const EVENT_MAP = {
  pre_tool:     { claude: 'PreToolUse', opencode: 'tool.execute.before', jonggrang: 'tool_call'    },
  post_tool:    { claude: 'PostToolUse', opencode: 'tool.execute.after', jonggrang: 'tool_result'  },
  stop:         { claude: 'Stop',        opencode: 'session.idle',       jonggrang: 'agent_stop'   },
  // ...
};
```

**If your tool supports hooks/extensions:**

1. Add your tool's event names to `EVENT_MAP`:
   ```js
   pre_tool: { ..., mytool: 'before_tool_call' },
   ```

2. Create `hooks/mytool/plugin.js` (for plugin-based tools) or `hooks/mytool/extension.ts` (for TypeScript extension APIs). Use `hooks/opencode/plugin.js` and `hooks/pi/jonggrang-extension.ts` as references.

3. Add an `installMytoolHooks(projectRoot, jonggrangInstallDir)` function to `lib/hooks.js` following the pattern of `installOpenCodePlugin()` or `installPiExtension()`.

4. Call it from `installHooksForTool()`:
   ```js
   function installHooksForTool(projectRoot, tool, jonggrangInstallDir) {
     // ...existing installs...
     const mytoolPath = installMytoolHooks(projectRoot, jonggrangInstallDir);
     results.mytool = { installed: true, path: mytoolPath };
     return results;
   }
   ```

**If your tool does not support hooks:** no changes to `lib/hooks.js` needed.

---

## 4. `bin/jonggrang.js`

### 4a. `checkDeps()` — line ~129

**CLI binary tool** (tool name = binary name):

The `else` branch already handles any CLI tool generically via `commandExists(TOOL)`. Nothing needs to change *unless* you want a custom install hint (see 4b below).

**SDK/npm package tool** (like jonggrang):

Add an `if (TOOL === 'mytool')` block that checks whether the package exists in node_modules:

```js
} else if (TOOL === 'mytool') {
  let found = false;
  try {
    const { createRequire } = require('module');
    const req = createRequire(path.join(PROJECT_ROOT, 'package.json'));
    const reqSelf = createRequire(__filename);
    const searchPaths = [
      ...(req.resolve.paths('@myorg/mytool-sdk') || []),
      ...(reqSelf.resolve.paths('@myorg/mytool-sdk') || []),
    ];
    try {
      const globalRoot = execSync('npm root -g', { encoding: 'utf8', timeout: 3000 }).trim();
      if (globalRoot) searchPaths.push(globalRoot);
    } catch {}
    for (const p of searchPaths) {
      if (lib.fileExists(path.join(p, '@myorg', 'mytool-sdk', 'package.json'))) {
        found = true; break;
      }
    }
  } catch {}
  if (!found) missing.push('@myorg/mytool-sdk');
} else {
  if (!commandExists(TOOL)) missing.push(TOOL);
}
```

### 4b. `checkDeps()` install hint switch — line ~165

Add a `case` for the install message shown when the dependency is missing:

```js
case 'mytool':         console.log('  Install mytool:    npm install -g mytool-cli'); break;
// or for SDK:
case '@myorg/mytool-sdk': console.log('  Install mytool SDK:  npm install -g @myorg/mytool-sdk'); break;
```

### 4c. `cmdInit()` — interactive `select()` — line ~1594

```js
options: [
  { value: 'jonggrang', label: 'Jonggrang   — primary tool (Recommended)' },
  { value: 'claude',    label: 'Claude Code — primary tool' },
  { value: 'opencode',  label: 'OpenCode    — primary tool' },
  { value: 'mytool',    label: 'MyTool      — short description' },   // ADD
],
```

### 4d. `cmdInit()` — non-interactive `ask()` fallback — line ~1624

```js
if (!INIT_TOOL) INIT_TOOL = await ask(rl, 'Primary AI tool:', 'jonggrang', 'jonggrang|claude|opencode|mytool');
```

### 4e. `cmdHelp()` — line ~3079

Update the tool list in init flags:

```
--tool <tool>           jonggrang | claude | opencode | mytool (default: jonggrang)
```

Update the `Work / Plan / Review flags` line:

```
--tool <tool>           Override AI tool (jonggrang | claude | opencode | mytool)
```

Add a row to the backend mapping table:

```
--model / --effort backend mapping:
  --tool claude:     --model opus|sonnet|haiku|best|<full-id>   --effort low|medium|high|max|xhigh
  --tool opencode:   --model anthropic/claude-sonnet-4-5-20250929  --effort high  (→ --variant)
  --tool jonggrang:  --model anthropic/claude-sonnet-4-5  --effort high  (→ SDK thinkingLevel)
  --tool mytool:     --model <...>  --effort <...>  (→ <backend flag>)
```

Add an example in the Examples section:

```
jonggrang work --tool mytool --model myprovider/my-model --effort high
```

---

## 5. `hooks/` directory structure

```
hooks/
├── claude/                   ← shell scripts for Claude Code hooks
│   ├── block-sensitive-files.sh
│   ├── feedback-loop.sh
│   └── ...
├── opencode/
│   └── plugin.js             ← OpenCode plugin (loaded via .opencode/plugins/)
└── pi/
    └── jonggrang-extension.ts ← TypeScript Pi SDK extension (loaded via --extension)
```

For a new tool, create `hooks/mytool/` with the appropriate hook format. The source directory is copied into the project at `jonggrang init` time by `installHooksForTool()` in `lib/hooks.js`.

---

## 6. `test/backend-args.test.js`

Add test cases for `buildAgentArgs` with your tool:

```js
// ── MyTool backend ────────────────────────────────────────────

test('mytool: --model alone', () => {
  assert.deepStrictEqual(
    buildAgentArgs({ tool: 'mytool', model: 'my-model', effort: '' }),
    ['--model', 'my-model']
  );
});

test('mytool: --effort → --thinking', () => {
  assert.deepStrictEqual(
    buildAgentArgs({ tool: 'mytool', model: '', effort: 'high' }),
    ['--thinking', 'high']
  );
});

test('mytool: --model + --effort', () => {
  assert.deepStrictEqual(
    buildAgentArgs({ tool: 'mytool', model: 'my-model', effort: 'medium' }),
    ['--model', 'my-model', '--thinking', 'medium']
  );
});
```

Run with `npm test`.

---

## 7. Documentation

### `docs/CONFIG.md`

- Add `mytool` to the `tool` field description
- Add a `mytool` entry to the `tools.<tool>` per-tool override example
- Add a column or row to the backend mapping table
- Add `mytool` to the `JONGGRANG_TOOL` environment variable description

### `docs/WORKFLOW.md`

Add an example in the "Work Loop Variants" section:

```bash
jonggrang work --tool mytool --model myprovider/my-model --effort high
```

### `README.md`

- Add `mytool` to the "Supports N AI agent backends" sentence
- Add install instructions under **Requirements**
- Add `mytool` to the `--tool` init flag table
- Add an example in the `jonggrang work` section
- Update the `--model / --effort` backend mapping table

---

## Summary of files touched

| File | What changes |
|------|-------------|
| `lib/backend-args.js` | New `case 'mytool':` in `buildAgentArgs` |
| `lib/jonggrang.js` | `resolveSkillsDir`, `runAgent`, `generateConfig`, `skillTargets` |
| `lib/hooks.js` | `EVENT_MAP`, new installer function, `installHooksForTool` (if hooks needed) |
| `bin/jonggrang.js` | `checkDeps` (check + hint), `cmdInit` (select + ask), `cmdHelp` (text + table) |
| `hooks/mytool/` | New directory with plugin/extension file (if hooks needed) |
| `test/backend-args.test.js` | New test cases for `buildAgentArgs` |
| `docs/CONFIG.md` | Tool list, mapping table, env var |
| `docs/WORKFLOW.md` | Example command |
| `README.md` | Requirements, tool list, examples |
