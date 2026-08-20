// Design templates — global, reusable design packs stored at ~/.jonggrang/design/<name>/.
// A design template is a superset of a UI baseline pack (manifest.yml + guide-fragment.md
// + tokens.css.template) that additionally ships framework-agnostic HTML+token components.
// It loads through the same pack machinery as built-in baselines (lib/ui-context.js), so a
// personal template is selectable in `plan` exactly like a built-in baseline pack.

const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');
const ui = require('./ui-context');

const DESIGN_FORMAT = 'jonggrang-ui-guide/v1'; // shares the guide format
const DEFAULT_COMPONENTS = ['button', 'input', 'card', 'nav', 'section'];

// JONGGRANG_HOME carries two different meanings in this codebase: server.js and
// bin/jonggrang.js resolve it to the INSTALL directory (the checkout that ships
// `templates/`), while the design store is USER DATA that belongs in
// ~/.jonggrang — the very path apis/design.js bind-mounts into the studio
// container. Reading the install dir as a data dir scattered new templates into
// the checkout: the studio then listed nothing (the real store was elsewhere)
// and starting a session crashed on a container cwd that did not exist.
//
// An install directory is recognised the same way server.js recognises its own,
// so an explicit JONGGRANG_HOME that points at a data dir (what the tests use to
// isolate the store) keeps working.
function isInstallDir(dir) {
  try { return fs.existsSync(path.join(dir, 'templates', 'AGENTS.md.template')); } catch { return false; }
}

function jonggrangHome() {
  const env = process.env.JONGGRANG_HOME;
  if (env && !isInstallDir(env)) return env;
  return path.join(os.homedir(), '.jonggrang');
}

function designRoot() {
  return process.env.JONGGRANG_DESIGN_HOME || path.join(jonggrangHome(), 'design');
}

// Templates stranded in the old (install-dir) location would otherwise just
// disappear from the studio with no explanation. Say where they are, once.
let legacyNoticeShown = false;
function warnStrandedTemplates() {
  if (legacyNoticeShown) return;
  const env = process.env.JONGGRANG_HOME;
  if (!env || !isInstallDir(env)) return;
  const stranded = path.join(env, 'design');
  const canonical = designRoot();
  if (stranded === canonical) return;
  let names = [];
  try {
    names = fs.readdirSync(stranded).filter(n => n !== 'core' && fs.statSync(path.join(stranded, n)).isDirectory());
  } catch { return; }
  if (!names.length) return;
  legacyNoticeShown = true;
  console.warn(`[design] ${names.length} template(s) sit in ${stranded} (an install directory): ${names.join(', ')}`);
  console.warn(`[design] the store is ${canonical} — move them there for the studio to see them`);
}

function templateDir(root, name) {
  return path.join(root, name);
}

// The pack loader reads shared core/ files from the catalog dir. Seed them from the
// built-in baseline catalog so ~/.jonggrang/design behaves like a pack catalog.
function ensureCore(root = designRoot()) {
  const core = path.join(root, 'core');
  fs.mkdirSync(core, { recursive: true });
  const src = path.join(ui.baselineCatalogPath(), 'core');
  for (const file of ['guide-sections.md', 'semantic-token-contract.md']) {
    const dst = path.join(core, file);
    const from = path.join(src, file);
    if (!fs.existsSync(dst) && fs.existsSync(from)) fs.copyFileSync(from, dst);
  }
  return root;
}

// ── Listing / lookup ──────────────────────────────────────────────────────────

function listTemplates() {
  const root = designRoot();
  warnStrandedTemplates();
  if (!fs.existsSync(root)) return [];
  ensureCore(root);
  return ui.listBaselinePacks(root).map(pack => ({ ...pack, source: 'design' }));
}

function findPack(nameOrKey) {
  const root = designRoot();
  if (!fs.existsSync(root)) return null;
  ensureCore(root);
  const packs = ui.listBaselinePacks(root);
  return packs.find(p => p.key === nameOrKey || p.id === nameOrKey) || null;
}

function loadTemplate(nameOrKey) {
  const pack = findPack(nameOrKey);
  if (!pack) throw new Error(`design template not found: ${nameOrKey}`);
  if (!pack.valid) throw new Error(`design template invalid: ${pack.errors.join('; ')}`);
  const dir = path.dirname(pack.path);
  const loaded = ui.loadBaselinePack(pack.key, designRoot());
  const components = (pack.components || []).map(c => ({
    id: c.id,
    variants: Array.isArray(c.variants) ? c.variants : [],
    file: c.file,
    html: fs.readFileSync(path.resolve(dir, c.file), 'utf8'),
  }));
  return { ...loaded, dir, components };
}

// ── Validation (pack contract + component refs) ─────────────────────────────────

function validateTemplate(nameOrKey) {
  const pack = findPack(nameOrKey);
  if (!pack) return { valid: false, errors: [`design template not found: ${nameOrKey}`], warnings: [] };
  const errors = [...(pack.errors || [])];
  const warnings = [];
  const dir = path.dirname(pack.path);
  const root = path.resolve(dir);
  const components = pack.components;
  if (components !== undefined && !Array.isArray(components)) {
    errors.push('components must be an array when present');
  } else {
    for (const c of components || []) {
      if (!c || !c.id || !c.file) { errors.push('each component needs an id and a file'); continue; }
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(c.id)) errors.push(`component id must be kebab-case: ${c.id}`);
      let resolved;
      try { resolved = path.resolve(root, c.file); } catch { errors.push(`bad component path: ${c.file}`); continue; }
      if (!resolved.startsWith(root + path.sep)) errors.push(`component escapes template dir: ${c.file}`);
      else if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) errors.push(`component file missing: ${c.file}`);
      else if (/hsl\(|rgb\(|#[0-9a-fA-F]{3,8}\b/.test(fs.readFileSync(resolved, 'utf8'))) {
        warnings.push(`component ${c.id} uses raw color values; prefer --ui-* tokens`);
      }
    }
  }
  return { valid: errors.length === 0, errors: [...new Set(errors)], warnings: [...new Set(warnings)] };
}

// ── get: emit an artifact for an agent or the user ──────────────────────────────

function getArtifact(nameOrKey, what, opts = {}) {
  const t = loadTemplate(nameOrKey);
  if (what === 'tokens') return t.tokenTemplate;
  if (what === 'guide') return t.guideFragment;
  if (what === 'manifest') return yaml.dump(t.manifest);
  const comp = t.components.find(c => c.id === what || c.id === (opts.component || what));
  if (comp) {
    if (opts.variant && comp.variants.length && !comp.variants.includes(opts.variant)) {
      throw new Error(`unknown variant '${opts.variant}' for ${comp.id} (have: ${comp.variants.join(', ') || 'none'})`);
    }
    return comp.html;
  }
  const ids = t.components.map(c => c.id).join(', ') || '(none)';
  throw new Error(`unknown artifact: ${what}. Try: tokens, guide, manifest, or a component id [${ids}]`);
}

// ── Scaffold a new template ─────────────────────────────────────────────────────

function newTemplate(name, opts = {}) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error('template name must be kebab-case');
  const root = ensureCore(designRoot());
  const dir = templateDir(root, name);
  if (fs.existsSync(dir) && !opts.force) throw new Error(`template already exists: ${name} (use --force)`);
  fs.mkdirSync(path.join(dir, 'components'), { recursive: true });

  const manifest = {
    id: name,
    version: 1,
    intent: opts.intent || `Design template ${name}.`,
    product_shapes: opts.product_shapes || ['any'],
    recommend_keywords: opts.recommend_keywords || [],
    recommend_priority: 10,
    framework_targets: ['css', 'any'],
    guide_fragment: 'guide-fragment.md',
    token_template: 'tokens.css.template',
    components: [],
  };
  fs.writeFileSync(path.join(dir, 'manifest.yml'), yaml.dump(manifest), 'utf8');
  fs.writeFileSync(path.join(dir, 'guide-fragment.md'), scaffoldGuide(name), 'utf8');
  fs.writeFileSync(path.join(dir, 'tokens.css.template'), scaffoldTokens(), 'utf8');
  fs.writeFileSync(path.join(dir, '.meta.json'), JSON.stringify({ created_by: 'design new', tool: opts.tool || null }, null, 2), 'utf8');
  writeStudioInstructions(dir, name);
  return { name, dir };
}

// The studio drops an agent into a template directory with nothing but design
// files. Without a brief it does not know what the directory is, that a rendered
// preview exists, or that a browser is installed — so it reviews the CSS source
// and calls that a design review, or reaches for whatever library it can find.
// These two files are that brief. Both names are written because each backend
// reads a different one.
// Write the studio brief into a template. Existing templates get it the first
// time the studio opens them, so a template scaffolded before this existed is
// not left without instructions. Never overwrites: the brief is meant to be
// edited per template.
function writeStudioInstructions(dir, name) {
  const body = scaffoldStudioInstructions(name);
  let written = 0;
  for (const file of ['CLAUDE.md', 'AGENTS.md']) {
    const dest = path.join(dir, file);
    if (fs.existsSync(dest)) continue;
    try { fs.writeFileSync(dest, body, 'utf8'); written++; } catch { /* best effort */ }
  }
  return written;
}

function scaffoldStudioInstructions(name) {
  return `# Design template: ${name}

You are in a Jonggrang **design template**. The files here are the design itself:

| File | Holds |
|---|---|
| \`tokens.css.template\` | the semantic tokens every component must use |
| \`components/*.html\` | the components, one file each |
| \`guide-fragment.md\` | the written direction this template carries |
| \`manifest.yml\` | id, intent, which components exist |

## Look at the rendered design, not just the source

A token file that parses tells you nothing about whether the design works. This
template renders live, and \`anoa\` — a browser — is already installed here.
The studio exports the preview URL as **\`$JONGGRANG_DESIGN_PREVIEW\`**.

The browser is a session: start it once, then drive it.

\`\`\`bash
anoa --headless --port 9222 &          # once; anoa status: exit 3 = not running
anoa open "$JONGGRANG_DESIGN_PREVIEW"  # the whole template
anoa screenshot preview.png            # then read the screenshot back
anoa set media dark                    # dark mode is a design decision, check it
anoa set viewport 375 812              # and so is narrow
anoa errors                            # a page can look right and still throw
\`\`\`

Add \`&component=<id>\` to the URL to render one component on its own.

Run \`anoa skills get core\` for the workflow and \`anoa skills get commands\`
for every command. If \`anoa\` is not on PATH, install it rather than reaching
for another tool.

## Judge it on

- **Tokens:** colours, spacing and type come from tokens, never hard-coded values.
- **Both themes:** light and dark both render, with contrast that holds.
- **Narrow widths:** nothing overflows or scrolls sideways at 375px.
- **States:** hover, focus and disabled are visible, not implied.
- **Consistency:** a new component looks like it belongs to the ones already here.

Change the files, then look again. Saying it looks right without opening the
preview is the one thing to avoid.
`;
}

function scaffoldGuide(name) {
  return ui.REQUIRED_GUIDE_SECTIONS.reduce(
    (acc, section) => acc + `## ${section}\n\nTODO: describe ${section.toLowerCase()} for ${name}.\n\n`,
    `# ${name} design template\n\n`,
  );
}

function scaffoldTokens() {
  return [
    ':root {',
    '  --ui-canvas: oklch(0.985 0.006 85);',
    '  --ui-surface: oklch(1 0 0);',
    '  --ui-text: oklch(0.19 0.018 255);',
    '  --ui-text-muted: oklch(0.46 0.018 255);',
    '  --ui-border: oklch(0.86 0.012 85);',
    '  --ui-action: oklch(0.38 0.16 255);',
    '  --ui-action-hover: oklch(0.31 0.15 255);',
    '  --ui-focus: oklch(0.62 0.17 255);',
    '  --ui-space-1: 0.25rem; --ui-space-2: 0.5rem; --ui-space-3: 0.75rem; --ui-space-4: 1rem;',
    '  --ui-space-6: 1.5rem; --ui-space-8: 2rem; --ui-space-12: 3rem; --ui-space-16: 4rem;',
    '  --ui-radius-control: 0.25rem; --ui-radius-panel: 0.5rem;',
    '  --ui-content: 68rem; --ui-copy: 42rem;',
    '}',
    '',
  ].join('\n');
}

// ── Promote a project's design into a global template ───────────────────────────

function promoteFromProject(name, projectRoot, opts = {}) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error('template name must be kebab-case');
  const guidePath = ui.projectGuidePath(projectRoot);
  if (!fs.existsSync(guidePath)) throw new Error(`no .jonggrang/UI.md in project: ${projectRoot}`);
  const guide = fs.readFileSync(guidePath, 'utf8');
  const fm = ui.parseFrontmatter(guide);

  const root = ensureCore(designRoot());
  const dir = templateDir(root, name);
  if (fs.existsSync(dir) && !opts.force) throw new Error(`template already exists: ${name} (use --force)`);
  fs.mkdirSync(path.join(dir, 'components'), { recursive: true });

  // guide body without frontmatter → guide-fragment.md
  fs.writeFileSync(path.join(dir, 'guide-fragment.md'), fm.body != null ? fm.body.trim() + '\n' : guide, 'utf8');

  // token source → tokens.css.template (or scaffold if missing/planned)
  const tokenSource = fm.data && fm.data.token_source;
  let tokenWritten = false;
  if (tokenSource && !['none', 'planned'].includes(String(tokenSource))) {
    const src = path.resolve(projectRoot, String(tokenSource));
    if (src.startsWith(path.resolve(projectRoot) + path.sep) && fs.existsSync(src) && fs.statSync(src).isFile()) {
      fs.copyFileSync(src, path.join(dir, 'tokens.css.template'));
      tokenWritten = true;
    }
  }
  if (!tokenWritten) fs.writeFileSync(path.join(dir, 'tokens.css.template'), scaffoldTokens(), 'utf8');

  const manifest = {
    id: name,
    version: 1,
    intent: (fm.data && fm.data.description) || `Promoted from ${path.basename(projectRoot)}.`,
    product_shapes: opts.product_shapes || ['any'],
    recommend_keywords: opts.recommend_keywords || [],
    recommend_priority: 10,
    framework_targets: ['css', 'any'],
    guide_fragment: 'guide-fragment.md',
    token_template: 'tokens.css.template',
    components: [],
  };
  fs.writeFileSync(path.join(dir, 'manifest.yml'), yaml.dump(manifest), 'utf8');
  fs.writeFileSync(path.join(dir, '.meta.json'), JSON.stringify({
    created_by: 'design promote', promoted_from: projectRoot, baseline: fm.data && fm.data.baseline || null,
  }, null, 2), 'utf8');
  return { name, dir, tokenSource: tokenWritten ? tokenSource : null };
}

function removeTemplate(name) {
  const root = designRoot();
  const dir = templateDir(root, name);
  if (!fs.existsSync(dir)) throw new Error(`design template not found: ${name}`);
  fs.rmSync(dir, { recursive: true, force: true });
  return { name };
}

module.exports = {
  DESIGN_FORMAT,
  DEFAULT_COMPONENTS,
  jonggrangHome,
  designRoot,
  ensureCore,
  listTemplates,
  findPack,
  loadTemplate,
  validateTemplate,
  getArtifact,
  newTemplate,
  scaffoldStudioInstructions,
  writeStudioInstructions,
  scaffoldTokens,
  promoteFromProject,
  removeTemplate,
};
