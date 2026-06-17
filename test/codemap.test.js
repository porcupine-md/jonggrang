'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const codemap = require('../lib/codemap');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    failed++;
  }
}

// Create a temp project root with arbitrary contents for fixture-based tests.
// `setup(root)` is a function that mutates the directory (creates files, etc.).
function makeProject(setup) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jonggrang-codemap-'));
  setup(dir);
  return dir;
}

console.log('\ncodemap.js — deterministic codebase map\n');

// ============================================================
// Self-host: run codemap against this very repo (process.cwd()).
// The user asked for tests "against specific folders in this repo".
// ============================================================

const SELF = process.cwd();

test('self: project name + version come from package.json', () => {
  const cm = codemap.generateCodemap(SELF);
  assert.strictEqual(cm.project.name, 'jonggrang');
  assert.strictEqual(cm.project.version, '0.9.4');
});

test('self: detects express + socket.io from package.json deps', () => {
  const cm = codemap.generateCodemap(SELF);
  const ids = cm.frameworks.map(f => f.id);
  assert.ok(ids.includes('express'),  `expected 'express' in frameworks, got: ${ids.join(', ')}`);
  assert.ok(ids.includes('socketio'), `expected 'socketio' in frameworks, got: ${ids.join(', ')}`);
});

test('self: entry points include main (server.js) and bin (jonggrang)', () => {
  const cm = codemap.generateCodemap(SELF);
  const kinds = cm.entryPoints.map(e => e.kind);
  assert.ok(kinds.includes('main'), `expected 'main' entry point`);
  const bins = cm.entryPoints.filter(e => e.kind === 'bin');
  assert.ok(bins.length >= 1, `expected at least one bin entry point`);
  assert.ok(bins.some(b => b.target && b.target.includes('jonggrang.js')),
    `expected bin to reference bin/jonggrang.js, got: ${JSON.stringify(bins)}`);
});

test('self: npm scripts and Makefile targets are both captured', () => {
  const cm = codemap.generateCodemap(SELF);
  const sources = new Set(cm.buildScripts.map(s => s.source));
  assert.ok(sources.has('package.json'), `expected 'package.json' in build script sources`);
  assert.ok(sources.has('Makefile'),     `expected 'Makefile' in build script sources`);
  // Sanity: the 'test' script is wired to test/*.test.js
  const testScript = cm.buildScripts.find(s => s.name === 'test');
  assert.ok(testScript, `expected 'test' script`);
  assert.ok(testScript.command.includes('node test/'),
    `expected test script to invoke node test/, got: ${testScript.command}`);
});

test('self: conventions include AGENTS.md and CLAUDE.md', () => {
  const cm = codemap.generateCodemap(SELF);
  const labels = cm.conventions.map(c => c.label);
  assert.ok(labels.some(l => /AGENTS\.md/.test(l)),    `expected AGENTS.md convention, got: ${labels.join(', ')}`);
  assert.ok(labels.some(l => /CLAUDE\.md/.test(l)),    `expected CLAUDE.md convention, got: ${labels.join(', ')}`);
  assert.ok(labels.some(l => /GitHub Actions/.test(l)),`expected GitHub Actions convention`);
});

test('self: key files include README, package.json, Makefile', () => {
  const cm = codemap.generateCodemap(SELF);
  const paths = cm.keyFiles.map(k => k.path);
  assert.ok(paths.includes('README.md'),     `expected README.md in key files`);
  assert.ok(paths.includes('package.json'),  `expected package.json in key files`);
  assert.ok(paths.includes('Makefile'),      `expected Makefile in key files`);
  // Each key file has a size > 0
  for (const kf of cm.keyFiles) {
    assert.ok(kf.size > 0, `expected ${kf.path} to have a positive size`);
  }
});

test('self: directory tree excludes node_modules and .git', () => {
  const cm = codemap.generateCodemap(SELF);
  const paths = cm.directoryTree.map(e => e.path);
  assert.ok(!paths.some(p => p.startsWith('node_modules/')),
    `expected no node_modules entries`);
  assert.ok(!paths.some(p => p.startsWith('.git/')),
    `expected no .git entries`);
});

test('self: directory tree preserves hidden .github dir', () => {
  const cm = codemap.generateCodemap(SELF);
  const hidden = cm.directoryTree.filter(e => e.path.startsWith('.'));
  assert.ok(hidden.length > 0, `expected at least one hidden dir (.github), got none`);
  assert.ok(hidden.some(e => e.path === '.github/' && e.type === 'dir'),
    `expected '.github/' as a dir entry, got: ${JSON.stringify(hidden)}`);
});

test('self: tree formatter renders .github with leading dot', () => {
  const cm = codemap.generateCodemap(SELF);
  const md = codemap.formatCodemapMarkdown(cm, { maxChars: 50_000 });
  // The tree section should contain a line like '📁 .github' (with the dot).
  const treeSection = md.split('## Directory Structure')[1] || '';
  assert.ok(/📁 \.github\b/.test(treeSection),
    `expected '📁 .github' (with leading dot) in tree, got:\n${treeSection.split('\n').slice(0, 5).join('\n')}`);
});

test('self: tree formatter includes summary count line', () => {
  const cm = codemap.generateCodemap(SELF);
  const md = codemap.formatCodemapMarkdown(cm, { maxChars: 50_000 });
  const treeSection = md.split('## Directory Structure')[1] || '';
  assert.ok(/\(\d+ files?, \d+ dirs? total\)/.test(treeSection),
    `expected summary line '(N files, M dirs total)', got: ${treeSection.split('\n').slice(-3).join('\n')}`);
});

test('self: test framework detected from package.json scripts.test', () => {
  const cm = codemap.generateCodemap(SELF);
  assert.ok(cm.testFramework, `expected testFramework to be detected`);
  assert.ok(cm.testFramework.command, `expected testFramework.command`);
  assert.ok(cm.testFramework.command.includes('node test/'),
    `expected test command to invoke node test/, got: ${cm.testFramework.command}`);
});

test('self: lockfiles list includes package-lock.json (npm-managed)', () => {
  const cm = codemap.generateCodemap(SELF);
  assert.ok(cm.lockfiles.includes('package-lock.json'),
    `expected package-lock.json in lockfiles, got: ${JSON.stringify(cm.lockfiles)}`);
});

test('self: content hash is deterministic and 16 hex chars', () => {
  const a = codemap.computeContentHash(SELF);
  const b = codemap.computeContentHash(SELF);
  assert.strictEqual(a, b, `expected same hash on repeated calls, got ${a} vs ${b}`);
  assert.strictEqual(a.length, 16);
  assert.ok(/^[0-9a-f]{16}$/.test(a), `expected 16 lowercase hex chars, got: ${a}`);
});

test('self: content hash changes when package.json changes', () => {
  const proj = makeProject((root) => {
    fs.writeFileSync(path.join(root, 'package.json'),
      JSON.stringify({ name: 'tmp', version: '0.0.1' }));
  });
  const before = codemap.computeContentHash(proj);
  fs.writeFileSync(path.join(proj, 'package.json'),
    JSON.stringify({ name: 'tmp', version: '0.0.2' }));
  const after = codemap.computeContentHash(proj);
  assert.notStrictEqual(before, after,
    `expected hash to change when package.json version changes`);
  fs.rmSync(proj, { recursive: true, force: true });
});

// ============================================================
// Fixture: empty project (no package.json)
// ============================================================

test('fixture-empty: still produces a valid codemap (no packages, no frameworks)', () => {
  const proj = makeProject(() => {}); // empty directory
  const cm = codemap.generateCodemap(proj);
  assert.strictEqual(cm.project.name, path.basename(proj));
  assert.strictEqual(cm.packages.length, 0);
  assert.strictEqual(cm.frameworks.length, 0);
  assert.strictEqual(cm.entryPoints.length, 0);
  assert.strictEqual(cm.buildScripts.length, 0);
  assert.strictEqual(cm.testFramework, null);
  assert.deepStrictEqual(cm.lockfiles, []);
  fs.rmSync(proj, { recursive: true, force: true });
});

// ============================================================
// Fixture: React + Next.js + TypeScript project
// ============================================================

test('fixture-react-next: detects react, next, vite, vitest; typescript in conventions', () => {
  const proj = makeProject((root) => {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      name: 'demo',
      version: '1.0.0',
      type: 'module',
      dependencies: {
        react: '^18.0.0',
        next: '^14.0.0',
      },
      devDependencies: {
        typescript: '^5.0.0',
        vite: '^5.0.0',
        vitest: '^1.0.0',
      },
      scripts: {
        dev: 'next dev',
        build: 'next build',
        test: 'vitest run',
      },
      main: 'index.js',
    }));
    fs.writeFileSync(path.join(root, 'next.config.js'), 'module.exports = {};');
    fs.writeFileSync(path.join(root, 'tsconfig.json'), '{}');
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'app.tsx'), 'export const App = () => null;');
  });
  const cm = codemap.generateCodemap(proj);
  const ids = cm.frameworks.map(f => f.id);
  assert.ok(ids.includes('react'),  `expected react, got: ${ids.join(', ')}`);
  assert.ok(ids.includes('next'),   `expected next, got: ${ids.join(', ')}`);
  assert.ok(ids.includes('vite'),   `expected vite, got: ${ids.join(', ')}`);
  assert.ok(ids.includes('vitest'), `expected vitest, got: ${ids.join(', ')}`);
  // TypeScript shows up as a CONVENTION (from analyzeConventions) and as
  // an inferred convention from package.json's typescript dep.
  const convLabels = cm.conventions.map(c => c.label);
  assert.ok(convLabels.some(l => /TypeScript/.test(l)),
    `expected TypeScript convention, got: ${convLabels.join(', ')}`);
  // entry points + scripts + test framework
  assert.ok(cm.entryPoints.find(e => e.kind === 'main' && e.target === 'index.js'));
  assert.ok(cm.buildScripts.find(s => s.name === 'dev'  && s.command === 'next dev'));
  assert.ok(cm.buildScripts.find(s => s.name === 'test' && s.command === 'vitest run'));
  assert.strictEqual(cm.testFramework.id, 'vitest');
  fs.rmSync(proj, { recursive: true, force: true });
});

// ============================================================
// Fixture: Python project (pyproject.toml only)
// ============================================================

test('fixture-python: pyproject.toml yields python ecosystem package', () => {
  const proj = makeProject((root) => {
    fs.writeFileSync(path.join(root, 'pyproject.toml'),
      '[project]\nname = "demo"\nversion = "0.1.0"\n');
    fs.writeFileSync(path.join(root, 'README.md'), '# Demo');
  });
  const cm = codemap.generateCodemap(proj);
  const py = cm.packages.find(p => p.ecosystem === 'python');
  assert.ok(py, `expected python ecosystem package, got: ${JSON.stringify(cm.packages)}`);
  assert.strictEqual(py.manifest, 'pyproject.toml');
  // No npm frameworks should be detected
  assert.strictEqual(cm.frameworks.length, 0);
  fs.rmSync(proj, { recursive: true, force: true });
});

// ============================================================
// Fixture: hidden .github directory → tree preserves leading dot
// ============================================================

test('fixture-hiddendir: .github/ is rendered with the leading dot', () => {
  const proj = makeProject((root) => {
    fs.mkdirSync(path.join(root, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'name: ci');
    fs.writeFileSync(path.join(root, 'package.json'),
      JSON.stringify({ name: 'demo', version: '0.0.1' }));
  });
  const cm = codemap.generateCodemap(proj);
  // Tree includes .github
  const dotGithub = cm.directoryTree.find(e => e.path === '.github/' && e.type === 'dir');
  assert.ok(dotGithub, `expected '.github/' dir in tree, got: ${JSON.stringify(cm.directoryTree)}`);
  // Formatter renders it with the dot
  const md = codemap.formatCodemapMarkdown(cm, { maxChars: 10_000 });
  const treeSection = md.split('## Directory Structure')[1] || '';
  assert.ok(/📁 \.github\b/.test(treeSection),
    `expected '📁 .github' line in tree output, got: ${treeSection.split('\n').slice(0, 5).join('\n')}`);
  fs.rmSync(proj, { recursive: true, force: true });
});

test('fixture-hiddendir: .claude/ is filtered (in SKIP_DIRS) and does NOT appear', () => {
  const proj = makeProject((root) => {
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(root, '.claude', 'settings.json'), '{}');
    fs.writeFileSync(path.join(root, 'package.json'),
      JSON.stringify({ name: 'demo', version: '0.0.1' }));
  });
  const cm = codemap.generateCodemap(proj);
  const claudeInTree = cm.directoryTree.find(e => e.path.startsWith('.claude'));
  assert.ok(!claudeInTree, `expected no .claude entries in tree (SKIP_DIRS), got: ${JSON.stringify(claudeInTree)}`);
  fs.rmSync(proj, { recursive: true, force: true });
});

// ============================================================
// Tree formatter: truncation behaviour
// ============================================================

test('tree: formatter caps at 120 entries and shows "and N more" when exceeded', () => {
  const proj = makeProject((root) => {
    // Generate 200 files at the top level
    for (let i = 0; i < 200; i++) {
      fs.writeFileSync(path.join(root, `f${i.toString().padStart(3, '0')}.js`), `// file ${i}`);
    }
    fs.writeFileSync(path.join(root, 'package.json'),
      JSON.stringify({ name: 'demo', version: '0.0.1' }));
  });
  const cm = codemap.generateCodemap(proj);
  assert.ok(cm.directoryTree.length > 120,
    `expected >120 entries, got ${cm.directoryTree.length}`);
  const md = codemap.formatCodemapMarkdown(cm, { maxChars: 100_000 });
  assert.ok(/and \d+ more entries/.test(md),
    `expected "and N more entries" in truncated tree, got: ${md.split('\n').slice(-5).join('\n')}`);
  // The summary count still shows the TOTAL (not the visible)
  const match = md.match(/\((\d+) files?, (\d+) dirs? total\)/);
  assert.ok(match, `expected summary line with totals`);
  const totalFilesShown = parseInt(match[1], 10);
  assert.ok(totalFilesShown >= 200,
    `expected total files >= 200, got ${totalFilesShown}`);
  fs.rmSync(proj, { recursive: true, force: true });
});

// ============================================================
// Markdown formatter: structure and truncation
// ============================================================

test('markdown: output contains all expected section headers', () => {
  const proj = makeProject((root) => {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      name: 'demo',
      version: '0.0.1',
      main: 'index.js',
      dependencies: { express: '^4.0.0' },
      scripts: { start: 'node server.js', test: 'vitest run' },
      devDependencies: { vitest: '^1.0.0' },
    }));
    fs.writeFileSync(path.join(root, 'Makefile'), 'install:\n\t@echo ok\n');
    fs.writeFileSync(path.join(root, 'README.md'), '# Demo');
    fs.writeFileSync(path.join(root, 'tsconfig.json'), '{}');
  });
  const cm = codemap.generateCodemap(proj);
  const md = codemap.formatCodemapMarkdown(cm, { maxChars: 50_000 });
  for (const header of [
    '# Codebase Map',
    '## Packages',
    '## Frameworks',
    '## Entry Points',
    '## Build / Run Scripts',
    '## Tests',
    '## Conventions',
    '## Key Files',
    '## Directory Structure',
  ]) {
    assert.ok(md.includes(header), `expected markdown to contain '${header}'`);
  }
  fs.rmSync(proj, { recursive: true, force: true });
});

test('markdown: respects maxChars and shows truncation note when exceeded', () => {
  // Use the self-host codemap (large) and force a tight maxChars
  const cm = codemap.generateCodemap(SELF);
  const md = codemap.formatCodemapMarkdown(cm, { maxChars: 500 });
  assert.ok(md.length <= 600, // 500 + a small tail
    `expected markdown to be capped near 500 chars, got ${md.length}`);
  assert.ok(/truncated \(\d+ → 500 chars\)/.test(md),
    `expected truncation note '(N → 500 chars)', got: ${md.slice(-100)}`);
});

// ============================================================
// Cache layer
// ============================================================

test('cache: getCachePath returns .jonggrang/codemap/codemap.json', () => {
  const proj = makeProject(() => {});
  const p = codemap.getCachePath(proj);
  assert.strictEqual(p, path.join(proj, '.jonggrang', 'codemap', 'codemap.json'));
  fs.rmSync(proj, { recursive: true, force: true });
});

test('cache: writeCache creates the file and readCache returns it', () => {
  const proj = makeProject((root) => {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'demo', version: '0.0.1' }));
  });
  const cm = codemap.generateCodemap(proj);
  codemap.writeCache(proj, cm);
  const cachePath = codemap.getCachePath(proj);
  assert.ok(fs.existsSync(cachePath), `expected cache file to exist at ${cachePath}`);
  const cached = codemap.readCache(proj);
  assert.ok(cached, `expected readCache to return data`);
  assert.strictEqual(cached.contentHash, cm.contentHash);
  assert.strictEqual(cached.data.project.name, 'demo');
  fs.rmSync(proj, { recursive: true, force: true });
});

test('cache: getOrGenerateCodemap returns fromCache: false on first call, true on second', () => {
  const proj = makeProject((root) => {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'demo', version: '0.0.1' }));
  });
  const a = codemap.getOrGenerateCodemap(proj);
  assert.strictEqual(a.fromCache, false, `expected first call to NOT be from cache`);
  const b = codemap.getOrGenerateCodemap(proj);
  assert.strictEqual(b.fromCache, true,  `expected second call to be from cache`);
  assert.strictEqual(b.stale, false,    `expected second call to be fresh (not stale)`);
  fs.rmSync(proj, { recursive: true, force: true });
});

test('cache: modifying a file flips the result to stale: true', () => {
  const proj = makeProject((root) => {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'demo', version: '0.0.1' }));
  });
  codemap.getOrGenerateCodemap(proj); // warm cache
  // Modify package.json → hash changes
  fs.writeFileSync(path.join(proj, 'package.json'), JSON.stringify({ name: 'demo', version: '0.0.2' }));
  const result = codemap.getOrGenerateCodemap(proj);
  assert.strictEqual(result.fromCache, true,  `expected cached data to be returned`);
  assert.strictEqual(result.stale, true,      `expected result to be marked stale`);
  // force: true bypasses staleness and regenerates
  const forced = codemap.getOrGenerateCodemap(proj, { force: true });
  assert.strictEqual(forced.fromCache, false, `expected force: true to bypass cache`);
  fs.rmSync(proj, { recursive: true, force: true });
});

// ============================================================
// Cache file format: minified (single line, no indent)
// Human-readable output goes through the CLI `--json` flag instead.
// ============================================================

test('cache-file: written as a single line (minified JSON)', () => {
  const proj = makeProject((root) => {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'demo', version: '0.0.1' }));
  });
  const cm = codemap.generateCodemap(proj);
  codemap.writeCache(proj, cm);
  const cachePath = codemap.getCachePath(proj);
  const raw = fs.readFileSync(cachePath, 'utf8');
  // No newlines allowed in the cache file
  assert.ok(!raw.includes('\n'),
    `expected cache file to be minified (no newlines), got ${raw.split('\n').length} lines`);
  // No 2-space indent prefixes (which would indicate pretty-printing)
  assert.ok(!/\n  /.test(raw) && !/^  /m.test(raw),
    `expected no leading 2-space indent, found one`);
  fs.rmSync(proj, { recursive: true, force: true });
});

test('cache-file: is still valid JSON that readCache can parse', () => {
  const proj = makeProject((root) => {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'demo', version: '0.0.1' }));
  });
  const cm = codemap.generateCodemap(proj);
  codemap.writeCache(proj, cm);
  const cachePath = codemap.getCachePath(proj);
  const raw = fs.readFileSync(cachePath, 'utf8');
  // Verify it parses as JSON (would throw otherwise)
  const parsed = JSON.parse(raw);
  assert.ok(parsed, `expected cache file to parse as JSON`);
  assert.strictEqual(parsed.contentHash, cm.contentHash);
  assert.strictEqual(parsed.data.project.name, 'demo');
  fs.rmSync(proj, { recursive: true, force: true });
});

test('cache-file: minified is meaningfully smaller than pretty for the self-host repo', () => {
  // Generate a real codemap against the repo
  const cm = codemap.generateCodemap(SELF);
  const payload = {
    contentHash: cm.contentHash,
    generatedAt: cm.generatedAt,
    data: cm,
  };
  const minified = JSON.stringify(payload);
  const pretty   = JSON.stringify(payload, null, 2);
  // Minified should be at least 20% smaller (typical is ~50% smaller).
  const ratio = minified.length / pretty.length;
  assert.ok(ratio < 0.8,
    `expected minified to be <80% of pretty size, got ratio ${ratio.toFixed(2)} (min=${minified.length}b, pretty=${pretty.length}b)`);
});

// ============================================================
// Summary
// ============================================================

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
