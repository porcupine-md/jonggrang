//
// JONGGRANG — Codebase Map (codemap)
//
// Deterministic, lightweight, LLM-free codebase overview for agent context.
// Ported/adapted from pi-compass (https://github.com/MattDevy/pi-extensions).
// All decisions are file-system based; no network, no LLM calls.
//
// Storage layout (per project):
//   .jonggrang/codemap/codemap.json   { contentHash, generatedAt, data }
//
// Public API:
//   computeContentHash(projectRoot)
//   generateCodemap(projectRoot)            -> CodeMap
//   getOrGenerateCodemap(projectRoot, opts) -> { codemap, fromCache, stale }
//   formatCodemapMarkdown(codemap, opts)     -> string
//   getProjectContextMarkdown(projectRoot)  -> string (markdown with stale banner)
//   getCachePath(projectRoot)
//

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Files that change the codemap when their contents change.
const HASH_FILES = [
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'tsconfig.json',
  'jsconfig.json',
  'Cargo.toml',
  'Cargo.lock',
  'go.mod',
  'go.sum',
  'pyproject.toml',
  'requirements.txt',
  'Gemfile',
  'Gemfile.lock',
  'composer.json',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'mix.exs',
  '.tool-versions',
  '.nvmrc',
  '.node-version',
  '.gitignore',
  '.gitattributes',
];

// Directories we never recurse into.
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.jonggrang', '.claude', '.opencode', '.worktree',
  'dist', 'build', 'out', 'coverage', '.next', '.nuxt', '.svelte-kit',
  '.cache', '.parcel-cache', '.turbo', '.vercel', '__pycache__',
  'venv', '.venv', 'env', 'target', 'vendor', '.idea', '.vscode', '.DS_Store',
]);

// Files we always surface as "key files" if they exist.
const KEY_FILE_CANDIDATES = [
  'AGENTS.md', 'CLAUDE.md', 'README.md', 'README', 'CONTRIBUTING.md', 'CHANGELOG.md',
  'package.json', 'tsconfig.json', 'jsconfig.json', 'Cargo.toml', 'go.mod', 'pyproject.toml',
  '.jonggrang/jonggrang.json', 'Makefile', 'Dockerfile', 'docker-compose.yml',
];

// Framework detection: (name, detector(dirs, files, pkg))
const FRAMEWORK_RULES = [
  { id: 'next',     name: 'Next.js',     match: (d, f, p) => p?.dependencies?.next || p?.devDependencies?.next || f.has('next.config.js') || f.has('next.config.mjs') || f.has('next.config.ts') },
  { id: 'nuxt',     name: 'Nuxt',        match: (d, f, p) => p?.dependencies?.nuxt || p?.devDependencies?.nuxt || f.has('nuxt.config.ts') || f.has('nuxt.config.js') },
  { id: 'remix',    name: 'Remix',       match: (d, f, p) => p?.dependencies?.['@remix-run/react'] || p?.dependencies?.['@remix-run/node'] },
  { id: 'react',    name: 'React',       match: (d, f, p) => !!p?.dependencies?.react || !!p?.devDependencies?.react },
  { id: 'vue',      name: 'Vue',         match: (d, f, p) => !!p?.dependencies?.vue || !!p?.devDependencies?.vue },
  { id: 'svelte',   name: 'Svelte',      match: (d, f, p) => !!p?.dependencies?.svelte || !!p?.devDependencies?.svelte || f.has('svelte.config.js') },
  { id: 'solid',    name: 'SolidJS',     match: (d, f, p) => !!p?.dependencies?.['solid-js'] },
  { id: 'angular',  name: 'Angular',     match: (d, f, p) => !!p?.dependencies?.['@angular/core'] || f.has('angular.json') },
  { id: 'express',  name: 'Express',     match: (d, f, p) => !!p?.dependencies?.express },
  { id: 'fastify',  name: 'Fastify',     match: (d, f, p) => !!p?.dependencies?.fastify },
  { id: 'hono',     name: 'Hono',        match: (d, f, p) => !!p?.dependencies?.hono },
  { id: 'koa',      name: 'Koa',         match: (d, f, p) => !!p?.dependencies?.koa },
  { id: 'nest',     name: 'NestJS',      match: (d, f, p) => !!p?.dependencies?.['@nestjs/core'] },
  { id: 'electron', name: 'Electron',    match: (d, f, p) => !!p?.dependencies?.electron || !!p?.devDependencies?.electron },
  { id: 'vite',     name: 'Vite',        match: (d, f, p) => !!p?.devDependencies?.vite || !!p?.dependencies?.vite || f.has('vite.config.ts') || f.has('vite.config.js') },
  { id: 'webpack',  name: 'webpack',     match: (d, f, p) => !!p?.devDependencies?.webpack || !!p?.dependencies?.webpack || f.has('webpack.config.js') },
  { id: 'esbuild',  name: 'esbuild',     match: (d, f, p) => !!p?.devDependencies?.esbuild || !!p?.dependencies?.esbuild },
  { id: 'rollup',   name: 'Rollup',      match: (d, f, p) => !!p?.devDependencies?.rollup || !!p?.dependencies?.rollup || f.has('rollup.config.js') },
  { id: 'parcel',   name: 'Parcel',      match: (d, f, p) => !!p?.devDependencies?.parcel || !!p?.dependencies?.parcel },
  { id: 'tailwind', name: 'Tailwind CSS',match: (d, f, p) => !!p?.devDependencies?.tailwindcss || !!p?.dependencies?.tailwindcss || f.has('tailwind.config.js') || f.has('tailwind.config.ts') },
  { id: 'prisma',   name: 'Prisma',      match: (d, f, p) => !!p?.dependencies?.['@prisma/client'] || !!p?.devDependencies?.prisma || d.has('prisma') },
  { id: 'drizzle',  name: 'Drizzle',     match: (d, f, p) => !!p?.dependencies?.['drizzle-orm'] },
  { id: 'typeorm',  name: 'TypeORM',     match: (d, f, p) => !!p?.dependencies?.typeorm },
  { id: 'sequelize',name: 'Sequelize',   match: (d, f, p) => !!p?.dependencies?.sequelize },
  { id: 'mongoose', name: 'Mongoose',    match: (d, f, p) => !!p?.dependencies?.mongoose },
  { id: 'vitest',   name: 'Vitest',      match: (d, f, p) => !!p?.devDependencies?.vitest },
  { id: 'jest',     name: 'Jest',        match: (d, f, p) => !!p?.devDependencies?.jest || !!p?.dependencies?.jest || f.has('jest.config.js') || f.has('jest.config.ts') },
  { id: 'playwright',name: 'Playwright', match: (d, f, p) => !!p?.devDependencies?.['@playwright/test'] },
  { id: 'cypress',  name: 'Cypress',     match: (d, f, p) => !!p?.devDependencies?.cypress },
  { id: 'socketio', name: 'Socket.IO',   match: (d, f, p) => !!p?.dependencies?.['socket.io'] },
  { id: 'langchain',name: 'LangChain',   match: (d, f, p) => !!p?.dependencies?.langchain || !!p?.dependencies?.['@langchain/core'] },
];

// Test framework detection (returns command + label).
function detectTestFramework(pkg) {
  if (!pkg) return null;
  const scripts = pkg.scripts || {};
  if (scripts.test) {
    if (pkg.devDependencies?.vitest || /vitest/.test(scripts.test))   return { id: 'vitest',    command: scripts.test };
    if (pkg.devDependencies?.jest   || /jest/.test(scripts.test))     return { id: 'jest',      command: scripts.test };
    if (pkg.devDependencies?.mocha  || /mocha/.test(scripts.test))    return { id: 'mocha',     command: scripts.test };
    if (pkg.devDependencies?.playwright || /playwright/.test(scripts.test)) return { id: 'playwright', command: scripts.test };
    if (pkg.devDependencies?.cypress  || /cypress/.test(scripts.test))  return { id: 'cypress',   command: scripts.test };
    return { id: 'custom', command: scripts.test };
  }
  return null;
}

// ── paths ────────────────────────────────────────────────────
function getCachePath(projectRoot) {
  return path.join(projectRoot, '.jonggrang', 'codemap', 'codemap.json');
}

// ── content hash ─────────────────────────────────────────────
// SHA256 over: HASH_FILES contents (skip missing) + sorted top-level dir names + file count.
function computeContentHash(projectRoot) {
  const h = crypto.createHash('sha256');
  // 1. tracked config files
  for (const rel of HASH_FILES) {
    const p = path.join(projectRoot, rel);
    if (fs.existsSync(p)) {
      try {
        const stat = fs.statSync(p);
        if (stat.isFile() && stat.size < 1_000_000) {
          h.update(`\n# ${rel}\n`);
          h.update(fs.readFileSync(p));
        } else {
          h.update(`\n# ${rel}\n<binary ${stat.size}b>\n`);
        }
      } catch { /* ignore */ }
    }
  }
  // 2. top-level directory layout
  try {
    const entries = fs.readdirSync(projectRoot, { withFileTypes: true });
    const sorted = entries
      .filter(e => !SKIP_DIRS.has(e.name) && !e.name.startsWith('.'))
      .map(e => `${e.isDirectory() ? 'd' : 'f'}:${e.name}`)
      .sort();
    h.update('\n# top-level\n');
    h.update(sorted.join('\n'));
  } catch { /* ignore */ }
  // 3. count of files (depth 3) — detects bulk changes
  let fileCount = 0;
  try {
    const walk = (dir, depth) => {
      if (depth > 3) return;
      const ents = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of ents) {
        if (SKIP_DIRS.has(e.name)) continue;
        if (e.name.startsWith('.')) continue;
        if (e.isDirectory()) walk(path.join(dir, e.name), depth + 1);
        else if (e.isFile()) fileCount++;
      }
    };
    walk(projectRoot, 0);
  } catch { /* ignore */ }
  h.update(`\n# fileCount\n${fileCount}\n`);
  return h.digest('hex').slice(0, 16);
}

// ── directory tree ───────────────────────────────────────────
// Depth-limited, prune SKIP_DIRS. Returns array of { path, type } for files only.
function analyzeDirectoryTree(projectRoot, opts = {}) {
  const maxDepth = opts.maxDepth || 3;
  const maxEntries = opts.maxEntries || 400;
  const result = [];
  const walk = (rel, depth) => {
    if (depth > maxDepth) return;
    if (result.length >= maxEntries) return;
    const abs = path.join(projectRoot, rel);
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); }
    catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (result.length >= maxEntries) return;
      if (SKIP_DIRS.has(e.name)) continue;
      if (e.name.startsWith('.') && depth === 0 && e.name !== '.github') continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        result.push({ path: childRel + '/', type: 'dir' });
        walk(childRel, depth + 1);
      } else if (e.isFile()) {
        result.push({ path: childRel, type: 'file' });
      }
    }
  };
  walk('', 0);
  return result;
}

// ── packages ─────────────────────────────────────────────────
function analyzePackages(projectRoot) {
  const packages = [];
  const lockfiles = [];
  for (const lock of ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb']) {
    if (fs.existsSync(path.join(projectRoot, lock))) lockfiles.push(lock);
  }
  for (const lock of ['Cargo.lock', 'Gemfile.lock', 'composer.lock', 'poetry.lock', 'Pipfile.lock']) {
    if (fs.existsSync(path.join(projectRoot, lock))) lockfiles.push(lock);
  }

  // node: package.json
  const pkgPath = path.join(projectRoot, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      packages.push({
        ecosystem: 'npm',
        name: pkg.name || path.basename(projectRoot),
        version: pkg.version || null,
        manager: lockfiles.find(l => l.endsWith('.json') || l.endsWith('.yaml') || l.endsWith('.lock')) || null,
        private: !!pkg.private,
        type: pkg.type || null,
        scripts: Object.keys(pkg.scripts || {}),
        deps: Object.keys(pkg.dependencies || {}).length,
        devDeps: Object.keys(pkg.devDependencies || {}).length,
      });
    } catch { /* ignore */ }
  }
  // python: pyproject.toml (best-effort, no full TOML parser)
  for (const f of ['pyproject.toml', 'requirements.txt', 'Pipfile', 'pyproject.lock']) {
    if (fs.existsSync(path.join(projectRoot, f))) {
      packages.push({ ecosystem: 'python', name: path.basename(projectRoot), manifest: f });
    }
  }
  // rust
  if (fs.existsSync(path.join(projectRoot, 'Cargo.toml'))) {
    packages.push({ ecosystem: 'rust', name: path.basename(projectRoot), manifest: 'Cargo.toml' });
  }
  // go
  if (fs.existsSync(path.join(projectRoot, 'go.mod'))) {
    packages.push({ ecosystem: 'go', name: path.basename(projectRoot), manifest: 'go.mod' });
  }
  return { packages, lockfiles };
}

// ── frameworks ───────────────────────────────────────────────
function analyzeFrameworks(projectRoot, pkg) {
  const files = new Set();
  const dirs = new Set();
  try {
    for (const e of fs.readdirSync(projectRoot, { withFileTypes: true })) {
      if (e.isDirectory()) dirs.add(e.name);
      else if (e.isFile()) files.add(e.name);
    }
  } catch { /* ignore */ }
  const detected = [];
  for (const rule of FRAMEWORK_RULES) {
    try {
      if (rule.match(dirs, files, pkg)) {
        detected.push({ id: rule.id, name: rule.name });
      }
    } catch { /* ignore */ }
  }
  return detected;
}

// ── entry points ─────────────────────────────────────────────
function analyzeEntryPoints(projectRoot, pkg) {
  const entries = [];
  if (!pkg) return entries;
  if (typeof pkg.main === 'string') entries.push({ kind: 'main', target: pkg.main });
  if (typeof pkg.bin === 'string') entries.push({ kind: 'bin', target: pkg.bin });
  else if (pkg.bin && typeof pkg.bin === 'object') {
    for (const [name, target] of Object.entries(pkg.bin)) {
      entries.push({ kind: 'bin', target, name });
    }
  }
  if (Array.isArray(pkg.exports)) {
    pkg.exports.forEach((e, i) => entries.push({ kind: 'exports', target: String(e), index: i }));
  } else if (pkg.exports && typeof pkg.exports === 'object') {
    for (const [cond, target] of Object.entries(pkg.exports)) {
      entries.push({ kind: 'exports', target: String(target), condition: cond });
    }
  }
  return entries;
}

// ── build / run scripts ──────────────────────────────────────
function analyzeBuildScripts(projectRoot, pkg) {
  const scripts = [];
  if (pkg?.scripts) {
    for (const [name, command] of Object.entries(pkg.scripts)) {
      scripts.push({ name, command, source: 'package.json' });
    }
  }
  // Makefile targets (first 20)
  const makePath = path.join(projectRoot, 'Makefile');
  if (fs.existsSync(makePath)) {
    try {
      const content = fs.readFileSync(makePath, 'utf8');
      const targets = [];
      const re = /^([a-zA-Z0-9_\-\.]+)\s*:/gm;
      let m;
      while ((m = re.exec(content)) !== null && targets.length < 20) {
        targets.push({ name: m[1], command: 'make ' + m[1], source: 'Makefile' });
      }
      scripts.push(...targets);
    } catch { /* ignore */ }
  }
  return scripts;
}

// ── conventions ──────────────────────────────────────────────
function analyzeConventions(projectRoot) {
  const conventions = [];
  const probes = [
    { file: 'tsconfig.json',         label: 'TypeScript' },
    { file: 'jsconfig.json',         label: 'JavaScript (with jsconfig)' },
    { file: '.eslintrc',             label: 'ESLint' },
    { file: '.eslintrc.json',        label: 'ESLint' },
    { file: '.eslintrc.js',          label: 'ESLint' },
    { file: 'eslint.config.js',      label: 'ESLint (flat config)' },
    { file: 'eslint.config.mjs',     label: 'ESLint (flat config)' },
    { file: '.prettierrc',           label: 'Prettier' },
    { file: '.prettierrc.json',      label: 'Prettier' },
    { file: 'prettier.config.js',    label: 'Prettier' },
    { file: '.editorconfig',         label: 'EditorConfig' },
    { file: '.nvmrc',                label: 'Node version pinned (.nvmrc)' },
    { file: '.node-version',         label: 'Node version pinned (.node-version)' },
    { file: '.tool-versions',        label: 'asdf tool versions' },
    { file: 'Dockerfile',            label: 'Docker' },
    { file: 'docker-compose.yml',    label: 'Docker Compose' },
    { file: 'docker-compose.yaml',   label: 'Docker Compose' },
    { file: '.github/workflows',     label: 'GitHub Actions' },
    { file: '.gitlab-ci.yml',        label: 'GitLab CI' },
    { file: '.circleci/config.yml',  label: 'CircleCI' },
    { file: 'AGENTS.md',             label: 'AGENTS.md (agent instructions)' },
    { file: 'CLAUDE.md',             label: 'CLAUDE.md (Claude instructions)' },
    { file: '.cursorrules',          label: '.cursorrules' },
    { file: '.windsurfrules',        label: '.windsurfrules' },
  ];
  for (const probe of probes) {
    const p = path.join(projectRoot, probe.file);
    if (fs.existsSync(p)) conventions.push({ label: probe.label, file: probe.file });
  }
  // detect formatter from package.json deps
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
    const all = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    if (all.prettier && !conventions.some(c => /Prettier/.test(c.label))) {
      conventions.push({ label: 'Prettier', file: 'package.json (prettier dep)' });
    }
    if (all.typescript && !conventions.some(c => /TypeScript/.test(c.label))) {
      conventions.push({ label: 'TypeScript', file: 'package.json (typescript dep)' });
    }
  } catch { /* ignore */ }
  return conventions;
}

// ── key files ────────────────────────────────────────────────
function analyzeKeyFiles(projectRoot) {
  const found = [];
  for (const rel of KEY_FILE_CANDIDATES) {
    const p = path.join(projectRoot, rel);
    if (fs.existsSync(p)) {
      try {
        const stat = fs.statSync(p);
        if (stat.isFile() && stat.size < 5_000_000) {
          found.push({ path: rel, size: stat.size });
        }
      } catch { /* ignore */ }
    }
  }
  return found;
}

// ── main entry ───────────────────────────────────────────────
function generateCodemap(projectRoot) {
  if (!projectRoot || !fs.existsSync(projectRoot)) {
    throw new Error(`generateCodemap: projectRoot does not exist: ${projectRoot}`);
  }
  const pkgPath = path.join(projectRoot, 'package.json');
  let pkg = null;
  if (fs.existsSync(pkgPath)) {
    try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')); } catch { /* ignore */ }
  }

  const { packages, lockfiles } = analyzePackages(projectRoot);
  const tests = detectTestFramework(pkg);

  return {
    project: {
      name: pkg?.name || path.basename(projectRoot),
      root: projectRoot,
      type: pkg?.type || null,
      version: pkg?.version || null,
    },
    contentHash: computeContentHash(projectRoot),
    generatedAt: new Date().toISOString(),
    directoryTree: analyzeDirectoryTree(projectRoot),
    packages,
    lockfiles,
    frameworks: analyzeFrameworks(projectRoot, pkg),
    entryPoints: analyzeEntryPoints(projectRoot, pkg),
    buildScripts: analyzeBuildScripts(projectRoot, pkg),
    testFramework: tests,        // { id, command } | null
    conventions: analyzeConventions(projectRoot),
    keyFiles: analyzeKeyFiles(projectRoot),
  };
}

// ── cache layer ──────────────────────────────────────────────
function readCache(projectRoot) {
  const cachePath = getCachePath(projectRoot);
  if (!fs.existsSync(cachePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  } catch { return null; }
}

function writeCache(projectRoot, codemap) {
  const cachePath = getCachePath(projectRoot);
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  const payload = {
    contentHash: codemap.contentHash,
    generatedAt: codemap.generatedAt,
    data: codemap,
  };
  // Minified (no indent) — cache is programmatic, never edited by hand.
  // For human-readable output, use `jonggrang codemap --json` (which goes
  // through formatCodemapMarkdown / pretty JSON.stringify in the CLI layer).
  // Saving ~50% file size and keeping any future committed cache readable
  // as a one-line diff.
  fs.writeFileSync(cachePath, JSON.stringify(payload));
}

function getOrGenerateCodemap(projectRoot, opts = {}) {
  const force = !!opts.force;
  const cache = readCache(projectRoot);
  if (cache && !force) {
    const currentHash = computeContentHash(projectRoot);
    const stale = cache.contentHash !== currentHash;
    if (!stale) return { codemap: cache.data, fromCache: true, stale: false };
    // Stale: regenerate instead of returning the outdated cache.
    try {
      const codemap = generateCodemap(projectRoot);
      writeCache(projectRoot, codemap);
      return { codemap, fromCache: false, stale: false, regenerated: true };
    } catch (e) {
      // Regeneration failed — fall back to cache with a stale flag so callers
      // can still warn, rather than crashing the prompt build.
      return { codemap: cache.data, fromCache: true, stale: true, currentHash, regenError: e && e.message };
    }
  }
  const codemap = generateCodemap(projectRoot);
  try { writeCache(projectRoot, codemap); } catch { /* best effort */ }
  return { codemap, fromCache: false, stale: false };
}

// ── markdown formatter ───────────────────────────────────────
function formatCodemapMarkdown(codemap, opts = {}) {
  const maxChars = opts.maxChars || 6000;
  const lines = [];
  lines.push(`# Codebase Map`);
  lines.push(`Project: \`${codemap.project.name}\`${codemap.project.version ? ` v${codemap.project.version}` : ''}${codemap.project.type ? ` (${codemap.project.type})` : ''}`);
  lines.push(`Generated: ${codemap.generatedAt}  •  Hash: \`${codemap.contentHash}\``);
  lines.push('');

  if (codemap.packages?.length) {
    lines.push('## Packages');
    for (const p of codemap.packages) {
      const extra = p.deps != null ? ` — ${p.deps} deps, ${p.devDeps} devDeps` : '';
      const ver = p.version ? ` v${p.version}` : '';
      lines.push(`- **${p.ecosystem}**: \`${p.name}\`${ver}${extra}${p.private ? ' (private)' : ''}`);
    }
    lines.push('');
  }

  if (codemap.frameworks?.length) {
    lines.push('## Frameworks');
    lines.push(codemap.frameworks.map(f => `- ${f.name} (\`${f.id}\`)`).join('\n'));
    lines.push('');
  }

  if (codemap.entryPoints?.length) {
    lines.push('## Entry Points');
    for (const e of codemap.entryPoints) {
      const name = e.name ? ` (\`${e.name}\`)` : '';
      const cond = e.condition ? ` — ${e.condition}` : '';
      lines.push(`- **${e.kind}**${name}: \`${e.target}\`${cond}`);
    }
    lines.push('');
  }

  if (codemap.buildScripts?.length) {
    lines.push('## Build / Run Scripts');
    const shown = codemap.buildScripts.slice(0, 25);
    for (const s of shown) {
      lines.push(`- \`${s.name}\` — \`${s.command}\` _(${s.source})_`);
    }
    if (codemap.buildScripts.length > shown.length) {
      lines.push(`- _…and ${codemap.buildScripts.length - shown.length} more_`);
    }
    lines.push('');
  }

  if (codemap.testFramework) {
    lines.push('## Tests');
    lines.push(`- Framework: **${codemap.testFramework.id}** — command: \`${codemap.testFramework.command}\``);
    lines.push('');
  }

  if (codemap.conventions?.length) {
    lines.push('## Conventions');
    lines.push(codemap.conventions.map(c => `- ${c.label} _(${c.file})_`).join('\n'));
    lines.push('');
  }

  if (codemap.keyFiles?.length) {
    lines.push('## Key Files');
    lines.push(codemap.keyFiles.map(f => `- \`${f.path}\` (${f.size}b)`).join('\n'));
    lines.push('');
  }

  if (codemap.directoryTree?.length) {
    lines.push('## Directory Structure');
    // Render as a tree. Each entry is e.g. "apis/legacy/compaction.js".
    // For a file: depth = slash count (a/b/c.js → 2 → 4 spaces)
    // For a dir:  depth = slash count - 1 (a/b/c/  → 1 → 2 spaces)
    //   because the trailing slash represents the dir itself, not a level
    //   beneath it.
    // Cap at 120 entries. Hidden dirs (those starting with '.') are filtered
    // by analyzeDirectoryTree() unless explicitly allow-listed (.github).
    const tree = codemap.directoryTree.slice(0, 120);
    for (const entry of tree) {
      const slashCount = (entry.path.match(/\//g) || []).length;
      const depth = entry.type === 'dir' ? Math.max(0, slashCount - 1) : slashCount;
      const parts = entry.path.split('/').filter(Boolean);
      const name = parts[parts.length - 1] || '(root)';
      const marker = entry.type === 'dir' ? '📁' : '📄';
      const indent = '  '.repeat(depth);
      lines.push(`${indent}${marker} ${name}`);
    }
    if (codemap.directoryTree.length > tree.length) {
      lines.push(`_…and ${codemap.directoryTree.length - tree.length} more entries_`);
    }
    // Summary line — gives the agent a count without needing to count icons.
    const totalFiles = codemap.directoryTree.filter(e => e.type === 'file').length;
    const totalDirs  = codemap.directoryTree.filter(e => e.type === 'dir').length;
    lines.push(`_(${totalFiles} files, ${totalDirs} dirs total)_`);
    lines.push('');
  }

  let md = lines.join('\n');
  if (md.length > maxChars) {
    md = md.slice(0, maxChars) + `\n\n_…truncated (${md.length} → ${maxChars} chars)_`;
  }
  return md;
}

function getProjectContextMarkdown(projectRoot, opts = {}) {
  const { codemap, stale } = getOrGenerateCodemap(projectRoot, opts);
  let md = `## Project Context (codemap)\n\n${formatCodemapMarkdown(codemap, opts)}`;
  if (stale) {
    md += `\n\n> ⚠️ This codemap may be outdated. The project structure has changed since \`${codemap.generatedAt}\`. Run \`jonggrang codemap --refresh\` to update.`;
  }
  return md;
}

module.exports = {
  computeContentHash,
  generateCodemap,
  getOrGenerateCodemap,
  formatCodemapMarkdown,
  getProjectContextMarkdown,
  getCachePath,
  readCache,
  writeCache,
};
