// UI context — project guide, feature handoff, baseline packs, and bounded task context.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');

const GUIDE_FORMAT = 'jonggrang-ui-guide/v1';
const REQUIRED_GUIDE_SECTIONS = [
  'Product and UX rationale',
  'Visual direction and baseline',
  'Source map',
  'Token contract, typography, and spacing',
  'Components and layout patterns',
  'Interaction, responsive, and accessibility rules',
  'References and verification',
  'Rules summary',
];
const REQUIRED_HANDOFF_SECTIONS = ['Feature intent', 'Shared direction', 'References'];
const BASELINE_IDS = [
  'landing-page-minimalist@1',
  'dashboard-operational@1',
  'mobile-app-minimalist@1',
];
const UI_DESCRIPTION_RE = /\b(ui|ux|frontend|front-end|screen|page|view|layout|visual|design|responsive|accessibility|a11y|component|button|input|select|dropdown|form|dialog|modal|toast|tooltip|icon|animation|table|dashboard|landing page|mobile app|navigation|sidebar|theme|dark mode|light mode|stylesheet|css|tailwind|storybook|figma)\b/i;
const UI_FILE_RE = /\.(css|scss|sass|less|vue|svelte|tsx|jsx|html)$/i;
const IGNORE_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.next', '.nuxt', 'vendor', '.jonggrang']);

function projectGuidePath(projectRoot) {
  return path.join(projectRoot, '.jonggrang', 'UI.md');
}

function draftGuidePath(projectRoot, sessionId) {
  return path.join(projectRoot, '.jonggrang', '.drafts', sessionId, 'UI.md');
}

function draftHandoffPath(projectRoot, sessionId) {
  return path.join(projectRoot, '.jonggrang', '.drafts', sessionId, 'UI_HANDOFF.md');
}

function featureHandoffPath(projectRoot, featureId) {
  return path.join(projectRoot, '.jonggrang', '.output', 'features', featureId, 'UI_HANDOFF.md');
}

function baselineCatalogPath() {
  return path.join(__dirname, '..', 'templates', 'ui-baselines');
}

function contentDigest(content) {
  return `sha256:${crypto.createHash('sha256').update(String(content || '')).digest('hex')}`;
}

function updateFrontmatter(content, updates) {
  const parsed = parseFrontmatter(content);
  if (parsed.error) throw new Error(parsed.error);
  const data = { ...parsed.data, ...updates };
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null || value === '') delete data[key];
  }
  return `---\n${yaml.dump(data, { lineWidth: -1, noRefs: true }).trimEnd()}\n---\n\n${parsed.body.replace(/^\s+/, '')}`;
}

function parseFrontmatter(content) {
  const match = String(content || '').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return { data: {}, body: String(content || ''), error: 'missing YAML frontmatter' };
  try {
    const data = yaml.load(match[1]) || {};
    return { data: typeof data === 'object' ? data : {}, body: String(content).slice(match[0].length), error: null };
  } catch (error) {
    return { data: {}, body: String(content || ''), error: `invalid YAML frontmatter: ${error.message}` };
  }
}

function markdownSections(content) {
  const lines = String(content || '').split(/\r?\n/);
  const sections = [];
  let fence = null;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const fenceMatch = line.match(/^(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (!fence) fence = { char: marker[0], length: marker.length };
      else if (marker[0] === fence.char && marker.length >= fence.length) fence = null;
      continue;
    }
    if (fence) continue;
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) sections.push({ level: heading[1].length, title: heading[2].trim(), line: index });
  }
  return { lines, sections, unclosedFence: Boolean(fence) };
}

function extractMarkdownSection(content, requestedTitle) {
  const parsed = markdownSections(content);
  const wanted = normalizeHeading(requestedTitle);
  const at = parsed.sections.findIndex(section => normalizeHeading(section.title) === wanted);
  if (at === -1) return '';
  const start = parsed.sections[at];
  const next = parsed.sections.slice(at + 1).find(section => section.level <= start.level);
  const end = next ? next.line : parsed.lines.length;
  return parsed.lines.slice(start.line, end).join('\n').trim();
}

function normalizeHeading(value) {
  return String(value || '')
    .replace(/^#+\s*/, '')
    .replace(/`/g, '')
    .trim()
    .toLowerCase();
}

function listBaselinePacks(catalogDir = baselineCatalogPath()) {
  const packs = [];
  if (!fs.existsSync(catalogDir)) return packs;
  for (const entry of fs.readdirSync(catalogDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'core') continue;
    const manifestPath = path.join(catalogDir, entry.name, 'manifest.yml');
    if (!fs.existsSync(manifestPath)) continue;
    try {
      const manifest = yaml.load(fs.readFileSync(manifestPath, 'utf8')) || {};
      const validation = validateBaselineManifest(manifest, path.dirname(manifestPath));
      packs.push({ ...manifest, key: `${manifest.id}@${manifest.version}`, path: manifestPath, valid: validation.valid, errors: validation.errors });
    } catch (error) {
      packs.push({ id: entry.name, version: null, key: entry.name, path: manifestPath, valid: false, errors: [error.message] });
    }
  }
  return packs.sort((a, b) => String(a.key).localeCompare(String(b.key)));
}

function resolvePackFile(packDir, relativePath) {
  if (!relativePath || path.isAbsolute(relativePath)) throw new Error(`baseline file must be relative: ${relativePath || '(empty)'}`);
  const root = path.resolve(packDir);
  const resolved = path.resolve(root, relativePath);
  if (!resolved.startsWith(root + path.sep)) throw new Error(`baseline file escapes pack directory: ${relativePath}`);
  return resolved;
}

function validateBaselineManifest(manifest, packDir) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object') return { valid: false, errors: ['manifest must be an object'] };
  if (!manifest.id || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(manifest.id)) errors.push('id must be kebab-case');
  if (!Number.isInteger(manifest.version) || manifest.version < 1) errors.push('version must be a positive integer');
  if (!manifest.intent) errors.push('intent is required');
  if (!Array.isArray(manifest.product_shapes) || manifest.product_shapes.length === 0) errors.push('product_shapes must not be empty');
  for (const field of ['guide_fragment', 'token_template']) {
    if (!manifest[field]) errors.push(`${field} is required`);
    else if (packDir) {
      try {
        const file = resolvePackFile(packDir, manifest[field]);
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) errors.push(`${field} does not exist: ${manifest[field]}`);
      } catch (error) {
        errors.push(error.message);
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

function loadBaselinePack(key, catalogDir = baselineCatalogPath()) {
  if (!BASELINE_IDS.includes(String(key))) throw new Error(`unknown baseline pack: ${key}`);
  const pack = listBaselinePacks(catalogDir).find(item => item.key === key);
  if (!pack) throw new Error(`baseline pack not found: ${key}`);
  if (!pack.valid) throw new Error(`baseline pack invalid: ${pack.errors.join('; ')}`);
  const packDir = path.dirname(pack.path);
  const readPackFile = relativePath => fs.readFileSync(resolvePackFile(packDir, relativePath), 'utf8');
  const coreDir = path.join(catalogDir, 'core');
  return {
    manifest: Object.fromEntries(Object.entries(pack).filter(([field]) => !['key', 'path', 'valid', 'errors'].includes(field))),
    key: pack.key,
    guideFragment: readPackFile(pack.guide_fragment),
    tokenTemplate: readPackFile(pack.token_template),
    guideSections: fs.readFileSync(path.join(coreDir, 'guide-sections.md'), 'utf8'),
    semanticTokenContract: fs.readFileSync(path.join(coreDir, 'semantic-token-contract.md'), 'utf8'),
  };
}

function detectUiWork(description, opts = {}) {
  const textParts = [description || ''];
  if (opts.srcPath) {
    textParts.push(opts.srcPath);
    if (UI_FILE_RE.test(opts.srcPath)) return true;
    try { textParts.push(fs.readFileSync(opts.srcPath, 'utf8').slice(0, 20000)); } catch {}
  }
  if (Array.isArray(opts.files) && opts.files.some(file => UI_FILE_RE.test(file))) return true;
  return UI_DESCRIPTION_RE.test(textParts.join('\n'));
}

function walkProjectFiles(projectRoot, maxFiles = 4000) {
  const files = [];
  const queue = [projectRoot];
  while (queue.length > 0 && files.length < maxFiles) {
    const current = queue.shift();
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (files.length >= maxFiles) break;
      if (entry.isDirectory() && IGNORE_DIRS.has(entry.name)) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) queue.push(full);
      else if (entry.isFile()) files.push(path.relative(projectRoot, full).split(path.sep).join('/'));
    }
  }
  return files;
}

function auditUiProject(projectRoot, opts = {}) {
  const files = walkProjectFiles(projectRoot, opts.maxFiles || 4000);
  let pkg = {};
  try { pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')); } catch {}
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const depNames = Object.keys(deps);
  const frameworkChecks = [
    ['next', ['next']], ['react', ['react']], ['nuxt', ['nuxt']], ['vue', ['vue']],
    ['svelte', ['svelte', '@sveltejs/kit']], ['angular', ['@angular/core']],
    ['react-native', ['react-native', 'expo']], ['flutter', []],
  ];
  const frameworks = frameworkChecks
    .filter(([name, names]) => (name === 'flutter' ? files.includes('pubspec.yaml') : names.some(dep => depNames.includes(dep))))
    .map(([name]) => name);
  const componentLibraries = depNames.filter(dep => /primevue|@mui\/|chakra|antd|radix|headlessui|shadcn|bootstrap|tailwind/i.test(dep));
  const tokens = files.filter(file => {
    const styleTokens = /(^|\/)(tokens?|theme|variables|global|main|app)\.(css|scss|sass|less)$/i.test(file);
    const structuredTokens = /(^|\/)(tokens?|design-tokens?|theme|variables)\.(json|ya?ml|ts|js)$/i.test(file);
    return styleTokens || structuredTokens;
  }).slice(0, 20);
  const components = files.filter(file => /(^|\/)(components?|ui)\//i.test(file) && UI_FILE_RE.test(file)).slice(0, 30);
  const screens = files.filter(file => /(^|\/)(pages?|views?|screens?|routes?)\//i.test(file) && /\.(vue|svelte|tsx|jsx|html)$/i.test(file)).slice(0, 20);
  const verification = [];
  for (const [name, command] of Object.entries(pkg.scripts || {})) {
    if (/test|lint|check|storybook|visual|a11y|playwright|cypress/i.test(name + ' ' + command)) verification.push(`npm run ${name}`);
  }
  const references = files.filter(file => /(^|\/)(storybook|stories|screenshots?|visual|design)\//i.test(file) || /\.stories\.[^.]+$/i.test(file)).slice(0, 20);
  const guidePath = projectGuidePath(projectRoot);
  const guideValidation = fs.existsSync(guidePath) ? validateUiGuide(projectRoot, guidePath, { allowPlanned: true }) : null;
  const userRoot = opts.userRoot || process.env.JONGGRANG_HOME || path.join(os.homedir(), '.jonggrang');
  const userGuidePath = path.join(userRoot, 'UI.md');
  const existingGuide = fs.existsSync(guidePath);
  const guideStatus = !existingGuide ? 'missing' : (guideValidation.valid ? 'ready' : 'needs-update');
  return {
    ui: true,
    framework: frameworks,
    component_libraries: componentLibraries,
    token_sources: tokens,
    components,
    screens,
    verification: verification.slice(0, 15),
    references,
    guide: {
      path: '.jonggrang/UI.md',
      status: guideStatus,
      errors: guideValidation ? guideValidation.errors : [],
      digest: existingGuide ? contentDigest(fs.readFileSync(guidePath, 'utf8')) : null,
    },
    user_guide: !existingGuide && fs.existsSync(userGuidePath) ? userGuidePath : null,
    baseline_packs: listBaselinePacks().filter(pack => pack.valid).map(pack => pack.key),
    truncated: files.length >= (opts.maxFiles || 4000),
  };
}

function recommendBaseline(description, audit = {}) {
  const explicit = BASELINE_IDS.find(id => String(description || '').toLowerCase().includes(id));
  if (explicit) return explicit;
  if ((audit.guide && audit.guide.status === 'ready') || ((audit.token_sources || []).length > 0 && (audit.components || []).length > 0)) return 'existing-project';
  const text = String(description || '').toLowerCase();
  if (/\b(mobile|ios|android|react native|react-native|flutter|expo)\b/.test(text) || (audit.framework || []).some(item => ['react-native', 'flutter'].includes(item))) {
    return 'mobile-app-minimalist@1';
  }
  if (/\b(landing|marketing|homepage|conversion|campaign|waitlist)\b/.test(text)) return 'landing-page-minimalist@1';
  if (/\b(dashboard|admin|operations?|console|backoffice|internal tool|data table)\b/.test(text)) return 'dashboard-operational@1';
  return null;
}

function pathStatus(projectRoot, value) {
  if (value == null || value === '' || value === 'none') return 'none';
  if (value === 'planned') return 'planned';
  const cleaned = String(value).replace(/\s+\((?:ready|planned).*\)$/, '');
  try {
    const resolved = resolveProjectPath(projectRoot, cleaned);
    return fs.existsSync(resolved) ? 'ready' : 'missing';
  } catch {
    return 'outside-project';
  }
}

function validateUiGuide(projectRoot, guideOrPath, opts = {}) {
  let content;
  let guidePath = null;
  if (typeof guideOrPath === 'string' && !guideOrPath.includes('\n') && guideOrPath.length < 4096 && fs.existsSync(guideOrPath)) {
    guidePath = guideOrPath;
    content = fs.readFileSync(guideOrPath, 'utf8');
  } else content = String(guideOrPath || '');
  const errors = [];
  const warnings = [];
  const fm = parseFrontmatter(content);
  if (fm.error) errors.push(fm.error);
  if (fm.data.format !== GUIDE_FORMAT) errors.push(`format must be ${GUIDE_FORMAT}`);
  const baseline = fm.data.baseline;
  if (!baseline) errors.push('baseline is required');
  else if (baseline !== 'existing-project' && !BASELINE_IDS.includes(String(baseline))) errors.push(`unknown baseline: ${baseline}`);
  const parsed = markdownSections(content);
  if (parsed.unclosedFence) errors.push('unclosed Markdown fence');
  const titles = new Set(parsed.sections.filter(section => section.level === 2).map(section => normalizeHeading(section.title)));
  for (const section of REQUIRED_GUIDE_SECTIONS) {
    if (!titles.has(normalizeHeading(section))) errors.push(`missing section: ${section}`);
  }
  const tokenStatus = fm.data.token_status || (fm.data.token_source === 'planned' ? 'planned' : 'ready');
  if (!['ready', 'planned'].includes(tokenStatus)) errors.push('token_status must be ready or planned');
  if (!fm.data.token_source) errors.push('token_source is required');
  else {
    const tokenSource = String(fm.data.token_source);
    const status = pathStatus(projectRoot, tokenSource);
    if (tokenSource === 'planned') errors.push('planned token_source must name a concrete project-relative destination');
    if (path.isAbsolute(tokenSource)) errors.push('token_source must be project-relative');
    if (status === 'outside-project') errors.push(`token_source escapes project root: ${tokenSource}`);
    if (tokenStatus === 'ready' && status !== 'ready') errors.push(`ready token_source does not exist: ${tokenSource}`);
    if (tokenStatus === 'ready' && status === 'ready') {
      const resolved = resolveProjectPath(projectRoot, tokenSource);
      if (!fs.statSync(resolved).isFile()) errors.push(`ready token_source must be a file: ${tokenSource}`);
    }
    if (tokenStatus === 'planned' && !opts.allowPlanned && !fm.data.token_owner_task) errors.push('planned token_source needs token_owner_task');
  }
  if (fm.data.component_source && !['none', 'planned'].includes(fm.data.component_source)) {
    const status = pathStatus(projectRoot, fm.data.component_source);
    if (status !== 'ready') warnings.push(`component_source does not exist: ${fm.data.component_source}`);
  }
  for (const sectionName of ['Source map', 'Components and layout patterns']) {
    const section = extractMarkdownSection(content, sectionName);
    const references = [...section.matchAll(/`([^`]+)`/g)].map(match => match[1]);
    for (const reference of references) {
      if (!/[/.]/.test(reference) || /^https?:\/\//.test(reference) || reference.startsWith('--')) continue;
      const clean = reference.replace(/#.*$/, '').replace(/[.,;:]$/, '');
      if (!clean || ['none', 'planned'].includes(clean)) continue;
      const status = pathStatus(projectRoot, clean);
      const isPlannedToken = tokenStatus === 'planned' && clean === fm.data.token_source;
      if (status !== 'ready' && !isPlannedToken) errors.push(`referenced path does not exist: ${clean}`);
    }
  }
  return { valid: errors.length === 0, errors: [...new Set(errors)], warnings: [...new Set(warnings)], frontmatter: fm.data, content, path: guidePath };
}

function validateUiTaskContext(projectRoot, task, featureId, guideDigest) {
  const errors = [];
  const context = task && task.ui_context;
  if (!context || typeof context !== 'object') return { valid: false, errors: [`${task && task.id ? task.id : 'task'} has no ui_context`] };
  const expectedHandoff = `.jonggrang/.output/features/${featureId}/UI_HANDOFF.md`;
  if (context.handoff !== expectedHandoff) errors.push(`${task.id} handoff must be ${expectedHandoff}`);
  if (!Array.isArray(context.sections) || !context.sections.includes(`Task ${task.id}`)) errors.push(`${task.id} sections must include Task ${task.id}`);
  for (const shared of ['Feature intent', 'Shared direction']) {
    if (!context.sections || !context.sections.includes(shared)) errors.push(`${task.id} sections must include ${shared}`);
  }
  if (context.guide !== '.jonggrang/UI.md') errors.push(`${task.id} guide must be .jonggrang/UI.md`);
  if (guideDigest && context.guide_revision !== guideDigest) errors.push(`${task.id} guide_revision does not match approved guide`);
  if (!Array.isArray(context.guide_sections)) errors.push(`${task.id} guide_sections must be an array`);
  else if (context.guide_sections.length === 0) errors.push(`${task.id} guide_sections must select at least one guide section`);
  if (!Array.isArray(context.source_files)) errors.push(`${task.id} source_files must be an array`);
  else {
    for (const source of context.source_files) {
      const status = pathStatus(projectRoot, source);
      if (path.isAbsolute(String(source)) || status === 'outside-project') errors.push(`${task.id} source file escapes project root: ${source}`);
      else if (status !== 'ready' && !(task.files || []).includes(source)) errors.push(`${task.id} source file does not exist and is not an owned target: ${source}`);
    }
  }
  if (!Array.isArray(context.states)) errors.push(`${task.id} states must be an array`);
  if (!Array.isArray(context.verification)) errors.push(`${task.id} verification must be an array`);
  if (context.on_conflict !== 'report UI_GUIDE_DRIFT') errors.push(`${task.id} on_conflict must report UI_GUIDE_DRIFT`);
  return { valid: errors.length === 0, errors };
}

function validateUiHandoff(projectRoot, handoffPath, tasks, opts = {}) {
  const errors = [];
  if (!fs.existsSync(handoffPath)) return { valid: false, errors: [`handoff not found: ${handoffPath}`] };
  const content = fs.readFileSync(handoffPath, 'utf8');
  const parsed = markdownSections(content);
  if (parsed.unclosedFence) errors.push('unclosed Markdown fence');
  for (const section of REQUIRED_HANDOFF_SECTIONS) {
    if (!extractMarkdownSection(content, section)) errors.push(`missing handoff section: ${section}`);
  }
  if (opts.guideDigest && !content.includes(`Guide revision: ${opts.guideDigest}`)) errors.push('handoff Guide revision does not match approved guide');
  if (opts.baseline && !content.includes(`Baseline: ${opts.baseline}`)) errors.push('handoff Baseline does not match approved guide');
  const guideContent = opts.guideContent || '';
  const guideHeadings = new Set(markdownSections(guideContent).sections.map(section => normalizeHeading(section.title)));
  const uiTasks = (tasks || []).filter(task => task.ui_context);
  for (const task of uiTasks) {
    if (!extractMarkdownSection(content, `Task ${task.id}`)) errors.push(`missing handoff section: Task ${task.id}`);
    const result = validateUiTaskContext(projectRoot, task, opts.featureId, opts.guideDigest);
    errors.push(...result.errors);
    for (const section of task.ui_context.guide_sections || []) {
      if (guideContent && !guideHeadings.has(normalizeHeading(section))) errors.push(`${task.id} references missing guide section: ${section}`);
    }
  }
  if (opts.tokenStatus === 'planned') {
    const foundations = uiTasks.filter(task => task.ui_context && task.ui_context.foundation === true);
    if (foundations.length !== 1) errors.push('planned token source needs exactly one UI-foundation task');
    else {
      const foundation = foundations[0];
      if (opts.tokenTemplate) {
        const section = extractMarkdownSection(content, `Task ${foundation.id}`);
        if (!section.includes(String(opts.tokenTemplate).trim())) {
          errors.push(`UI-foundation task ${foundation.id} must include the approved baseline token template`);
        }
      }
      for (const task of uiTasks) {
        if (task.id !== foundation.id && !(task.blocked_by || []).includes(foundation.id)) {
          errors.push(`${task.id} must be blocked by UI-foundation task ${foundation.id}`);
        }
      }
    }
  }
  return { valid: errors.length === 0, errors, content };
}

function setHandoffMetadata(content, fields) {
  let updated = String(content || '');
  for (const [label, value] of Object.entries(fields)) {
    const line = `${label}: ${value}`;
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`^${escaped}:.*$`, 'm');
    if (pattern.test(updated)) updated = updated.replace(pattern, line);
    else {
      const firstBreak = updated.indexOf('\n');
      updated = firstBreak === -1
        ? `${updated}\n\n${line}\n`
        : `${updated.slice(0, firstBreak + 1)}\n${line}\n${updated.slice(firstBreak + 1).replace(/^\n/, '')}`;
    }
  }
  return updated;
}

function writeFilesTransaction(entries, opts = {}) {
  const renameSync = opts.renameSync || fs.renameSync;
  const stamp = `${process.pid}.${Date.now()}`;
  const files = entries.map((entry, index) => ({
    file: entry.file,
    content: entry.content,
    existed: fs.existsSync(entry.file),
    temp: `${entry.file}.tmp.${stamp}.${index}`,
    backup: `${entry.file}.bak.${stamp}.${index}`,
  }));

  try {
    for (const item of files) fs.writeFileSync(item.temp, item.content, 'utf8');
    for (const item of files) {
      if (item.existed) renameSync(item.file, item.backup);
    }
    for (const item of files) renameSync(item.temp, item.file);
  } catch (error) {
    for (const item of [...files].reverse()) {
      try {
        if (fs.existsSync(item.backup)) {
          if (fs.existsSync(item.file)) fs.unlinkSync(item.file);
          renameSync(item.backup, item.file);
        } else if (!item.existed && fs.existsSync(item.file)) {
          fs.unlinkSync(item.file);
        }
      } catch {}
      try { if (fs.existsSync(item.temp)) fs.unlinkSync(item.temp); } catch {}
    }
    throw error;
  }
  for (const item of files) {
    try { if (fs.existsSync(item.backup)) fs.unlinkSync(item.backup); } catch {}
  }
}

function promoteUiFoundation(projectRoot, featureId, taskId) {
  const guidePath = projectGuidePath(projectRoot);
  const tasksPath = path.join(projectRoot, '.jonggrang', '.output', 'features', featureId, 'jonggrang-tasks.json');
  const handoffPath = featureHandoffPath(projectRoot, featureId);
  if (!fs.existsSync(guidePath)) throw new Error('UI foundation cannot finish: .jonggrang/UI.md is missing');
  if (!fs.existsSync(tasksPath)) throw new Error(`UI foundation cannot finish: tasks missing for ${featureId}`);
  if (!fs.existsSync(handoffPath)) throw new Error(`UI foundation cannot finish: UI_HANDOFF.md missing for ${featureId}`);
  const tasks = JSON.parse(fs.readFileSync(tasksPath, 'utf8'));
  const task = (tasks.tasks || []).find(item => item.id === taskId);
  if (!task || !task.ui_context || task.ui_context.foundation !== true) throw new Error(`${taskId} is not the designated UI-foundation task`);

  const current = fs.readFileSync(guidePath, 'utf8');
  const parsed = parseFrontmatter(current);
  if (parsed.error) throw new Error(parsed.error);
  if (parsed.data.token_owner_task && parsed.data.token_owner_task !== taskId) throw new Error(`UI foundation is owned by ${parsed.data.token_owner_task}, not ${taskId}`);
  const tokenSource = parsed.data.token_source;
  if (pathStatus(projectRoot, tokenSource) !== 'ready') throw new Error(`UI foundation cannot finish: token source does not exist: ${tokenSource}`);

  const updatedGuide = parsed.data.token_status === 'ready'
    ? current
    : updateFrontmatter(current, { token_status: 'ready', token_owner_task: taskId });
  const validation = validateUiGuide(projectRoot, updatedGuide, { allowPlanned: false });
  if (!validation.valid) throw new Error(`UI foundation guide invalid: ${validation.errors.join('; ')}`);
  const digest = contentDigest(updatedGuide);
  for (const item of tasks.tasks || []) {
    if (item.ui_context) item.ui_context.guide_revision = digest;
  }
  const handoff = setHandoffMetadata(fs.readFileSync(handoffPath, 'utf8'), {
    'Guide revision': digest,
    'Token source': `${tokenSource} (ready)`,
  });

  writeFilesTransaction([
    { file: guidePath, content: updatedGuide },
    { file: handoffPath, content: handoff },
    { file: tasksPath, content: JSON.stringify(tasks, null, 2) + '\n' },
  ]);
  return { guideRevision: digest, tokenSource };
}

function resolveProjectPath(projectRoot, relativePath) {
  if (typeof relativePath !== 'string' || !relativePath.trim()) throw new Error('UI context path is empty');
  const root = fs.realpathSync(projectRoot);
  const resolved = path.resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) throw new Error(`UI context path escapes project root: ${relativePath}`);

  // A lexically safe path can still escape through a symlinked parent. Resolve
  // the nearest existing ancestor so planned destinations remain inside root.
  let ancestor = resolved;
  while (!fs.existsSync(ancestor) && ancestor !== root) ancestor = path.dirname(ancestor);
  const realAncestor = fs.realpathSync(ancestor);
  if (realAncestor !== root && !realAncestor.startsWith(root + path.sep)) {
    throw new Error(`UI context path escapes project root through symlink: ${relativePath}`);
  }
  return resolved;
}

function projectRootFromStateFile(stateFile) {
  const absolute = path.resolve(stateFile || process.cwd());
  const marker = `${path.sep}.jonggrang${path.sep}`;
  const at = absolute.indexOf(marker);
  return at === -1 ? process.cwd() : absolute.slice(0, at);
}

function buildTaskUiPrompt(projectRoot, task, opts = {}) {
  if (!task || !task.ui_context) return '';
  const context = task.ui_context;
  const errors = [];
  let selected = '';
  try {
    const handoffPath = resolveProjectPath(projectRoot, context.handoff);
    const handoff = fs.readFileSync(handoffPath, 'utf8');
    const blocks = [];
    for (const section of context.sections || []) {
      const block = extractMarkdownSection(handoff, section);
      if (block) blocks.push(block);
      else errors.push(`missing handoff section: ${section}`);
    }
    selected = blocks.join('\n\n').slice(0, opts.maxChars || 10000);
  } catch (error) {
    errors.push(error.message);
  }
  return `## UI Task Context (bounded)

\`ui_context\`:
\`\`\`json
${JSON.stringify(context, null, 2)}
\`\`\`

Selected sections from \`${context.handoff}\`:

${selected || '(handoff text unavailable)'}
${errors.length ? `\nContext errors:\n${errors.map(error => `- ${error}`).join('\n')}\n` : ''}
Read only the root-guide sections and source files named above when more detail is
needed. Do not read the full guide by default. If the handoff, guide, or current
code disagree, stop guessing and report \`UI_GUIDE_DRIFT\` with the conflicting
paths and rules. Reuse local components and semantic tokens before creating new
ones.${context.foundation ? '\nThis is the designated UI-foundation task. Create and validate the approved token source before running `jonggrang task done`; the CLI atomically promotes the guide and handoff from planned to ready. Do not edit those metadata fields manually.' : ''}`;
}

function renderBaselinePackContext(pack, approved) {
  if (!pack) return '';
  return `
## ${approved ? 'Approved starter baseline' : 'Starter baseline candidate (not approved yet)'}

${approved ? 'Selected' : 'Candidate'}: \`${pack.key}\`

Manifest:
\`\`\`yaml
${yaml.dump(pack.manifest, { lineWidth: -1, noRefs: true }).trimEnd()}
\`\`\`

Guide fragment:
\`\`\`markdown
${pack.guideFragment.trim()}
\`\`\`

Semantic token contract:
\`\`\`markdown
${pack.semanticTokenContract.trim()}
\`\`\`

Token template:
\`\`\`css
${pack.tokenTemplate.trim()}
\`\`\`

${approved ? `The user explicitly selected this pack. Use its guide fragment and token
template as the approved starting point.` : `This content is a candidate, not permission to apply it. When preference
clarifications select the recommendation, use it exactly as the starting point.
When the user supplies their own preference/reference or declines a starter,
record \`existing-project\` as the project-owned baseline and do not copy this
starter token template.`}
`;
}

function buildUiPreferenceQuestion(planning) {
  const recommended = BASELINE_IDS.includes(planning.baseline) ? [planning.baseline] : [];
  const choices = recommended.length > 0 ? recommended : BASELINE_IDS;
  return {
    id: 'ui-preference',
    question: `${planning.baseline ? `Before using ${planning.baseline},` : 'Before choosing a starter,'} do you have your own UI preference/reference? Type a custom answer to provide a direction, URL, Figma file, or product reference. If not, select a starter or decline starter packs.`,
    rationale: 'A starter pack must not override project-specific visual preferences without approval.',
    type: 'single_choice',
    options: [
      ...choices.map((id, index) => ({
        value: `use:${id}`,
        label: `Use ${id}${index === 0 && planning.baseline === id ? ' (recommended)' : ''}`,
        rationale: 'Use this product-shape pack as the approved starting point.',
      })),
      {
        value: 'no-starter',
        label: 'Do not use a starter',
        rationale: 'Follow repository evidence and project-owned direction only.',
      },
    ],
    allow_freetext: true,
  };
}

function resolveUiPreference(planning, answers) {
  if (!planning || !planning.requiresBaselineConsent) return planning;
  const items = answers && Array.isArray(answers.answers) ? answers.answers : [];
  const answer = items.find(item => item.id === 'ui-preference');
  if (!answer) throw new Error('UI baseline selection requires an answer to the UI preference question');
  const custom = String(answer.freetext || '').trim();
  const value = String(answer.value || '');
  if (custom || value === 'no-starter') {
    const reason = custom
      ? `User-provided UI preference/reference: ${custom}`
      : 'The user declined a starter baseline; follow project-owned direction only.';
    return {
      ...planning,
      baseline: 'existing-project',
      baselinePack: null,
      requiresBaselineConsent: false,
      preferenceQuestion: null,
      prompt: `${planning.promptWithoutPack || planning.prompt}\n\n## Authoritative UI preference decision\n\n${reason}\nUse \`existing-project\` as the baseline. Do not copy any starter guide fragment or token template.`,
    };
  }
  if (value.startsWith('use:')) {
    const selected = value.slice(4);
    if (!BASELINE_IDS.includes(selected)) throw new Error(`unknown selected UI baseline: ${selected}`);
    const baselinePack = loadBaselinePack(selected);
    const promptBase = planning.promptWithoutPack || planning.prompt;
    const packContext = renderBaselinePackContext(baselinePack, true);
    return {
      ...planning,
      baseline: selected,
      baselinePack,
      requiresBaselineConsent: false,
      preferenceQuestion: null,
      prompt: `${promptBase.replace('\nBefore finishing the plan:', `${packContext}\nBefore finishing the plan:`)}\n\n## Authoritative UI preference decision\n\nThe user explicitly approved \`${selected}\` as the starter baseline.`,
    };
  }
  throw new Error('UI preference answer must select a starter, decline starters, or provide a custom direction');
}

function buildPlanningContext(projectRoot, sessionId, description, audit) {
  const explicitBaseline = BASELINE_IDS.find(id => String(description || '').toLowerCase().includes(id)) || null;
  const recommendation = recommendBaseline(description, audit);
  // A personal guide is already an explicit preference input and outranks a
  // keyword-selected built-in pack. An exact pack id in the request outranks it.
  const baseline = audit.user_guide && !explicitBaseline ? 'existing-project' : recommendation;
  const baselinePack = BASELINE_IDS.includes(baseline) ? loadBaselinePack(baseline) : null;
  const requiresBaselineConsent = Boolean(
    !explicitBaseline
    && audit.guide.status !== 'ready'
    && !audit.user_guide
    && baseline !== 'existing-project',
  );
  const guideStatus = audit.guide.status === 'ready' ? 'unchanged' : (audit.guide.status === 'missing' ? 'update proposed' : 'needs input');
  const guideDraft = draftGuidePath(projectRoot, sessionId);
  const handoffDraft = draftHandoffPath(projectRoot, sessionId);
  const existingGuide = projectGuidePath(projectRoot);
  const userGuideNote = audit.user_guide
    ? `An optional personal guide is available at \`${audit.user_guide}\`. Treat it as input only; do not copy it unchanged.`
    : 'No optional personal guide was found.';
  const packContext = renderBaselinePackContext(baselinePack, !requiresBaselineConsent);
  const planning = {
    ui: true,
    baseline,
    baselinePack,
    explicitBaseline,
    requiresBaselineConsent,
    guideStatus,
    guideDraft,
    handoffDraft,
    existingGuide,
    prompt: `## UI Planning Contract

This request affects UI. The deterministic repository audit is below:
\`\`\`json
${JSON.stringify(audit, null, 2)}
\`\`\`

${userGuideNote}
Baseline recommendation: ${baseline || 'uncertain — ask the user before choosing'}.
${requiresBaselineConsent ? (baseline ? 'This recommendation is NOT selected. Ask for user preference/reference first; only use the starter after explicit consent.' : 'No starter is selected. Ask for user preference/reference first, then require an explicit starter choice or no-starter choice.') : 'The baseline is supported by existing project evidence, an optional personal guide, or an explicit baseline in the request.'}
UI guide status: ${guideStatus}.
${packContext}
Before finishing the plan:
1. Add \`ui: true\`, \`ui_guide_status: ${guideStatus}\`, \`ui_baseline: <id@version|existing-project>\`, and \`ui_token_status: ready|planned\` to plan frontmatter.
2. Write an approved-feature draft to \`${handoffDraft}\` with \`# UI handoff draft\`, then \`## Feature intent\`, \`## Shared direction\`, and \`## References\`. Use real local paths. Task sections are added during approval after task IDs exist.
3. ${guideStatus === 'unchanged' ? `Use the existing \`${existingGuide}\`; do not rewrite it merely to restyle the project.` : `Write the proposed complete project guide to \`${guideDraft}\`. It must use format \`${GUIDE_FORMAT}\`, pin the selected baseline, name a canonical token source and status, and contain all eight required sections.`}
4. If no token source exists, set it to a concrete project-relative destination with \`token_status: planned\`; approval will create one foundation task and block dependent UI tasks.
5. Do not require Figma, Storybook, a browser, DTCG, Tailwind, or a component library when the repository does not use it.

The plan and these sidecars are reviewed together. Do not implement UI code during planning.`,
  };
  planning.promptWithoutPack = packContext ? planning.prompt.replace(packContext, '') : planning.prompt;
  planning.preferenceQuestion = requiresBaselineConsent ? buildUiPreferenceQuestion(planning) : null;
  return planning;
}

module.exports = {
  GUIDE_FORMAT,
  REQUIRED_GUIDE_SECTIONS,
  REQUIRED_HANDOFF_SECTIONS,
  BASELINE_IDS,
  projectGuidePath,
  draftGuidePath,
  draftHandoffPath,
  featureHandoffPath,
  baselineCatalogPath,
  contentDigest,
  updateFrontmatter,
  parseFrontmatter,
  markdownSections,
  extractMarkdownSection,
  listBaselinePacks,
  loadBaselinePack,
  validateBaselineManifest,
  detectUiWork,
  auditUiProject,
  recommendBaseline,
  validateUiGuide,
  validateUiTaskContext,
  validateUiHandoff,
  setHandoffMetadata,
  writeFilesTransaction,
  promoteUiFoundation,
  resolveProjectPath,
  projectRootFromStateFile,
  buildTaskUiPrompt,
  buildUiPreferenceQuestion,
  resolveUiPreference,
  buildPlanningContext,
};
