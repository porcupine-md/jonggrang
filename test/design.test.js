const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');

// Isolate the design store to a temp JONGGRANG_HOME before requiring the module.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jg-design-'));
process.env.JONGGRANG_HOME = TMP;
const design = require('../lib/design');
const ui = require('../lib/ui-context');

function setComponents(name, components) {
  const dir = path.join(design.designRoot(), name);
  const manifest = yaml.load(fs.readFileSync(path.join(dir, 'manifest.yml'), 'utf8'));
  manifest.components = components;
  fs.writeFileSync(path.join(dir, 'manifest.yml'), yaml.dump(manifest));
  return dir;
}

test('newTemplate scaffolds a valid template with all 8 canonical guide sections', () => {
  const { dir } = design.newTemplate('acme-brand', { intent: 'Acme brand system', product_shapes: ['dashboard'] });
  assert.ok(fs.existsSync(path.join(dir, 'manifest.yml')));
  assert.ok(fs.existsSync(path.join(dir, 'tokens.css.template')));
  const v = design.validateTemplate('acme-brand');
  assert.deepEqual(v.errors, []);
  assert.ok(v.valid);
  const guide = design.getArtifact('acme-brand', 'guide');
  for (const s of ui.REQUIRED_GUIDE_SECTIONS) assert.ok(guide.includes('## ' + s), 'missing section: ' + s);
});

test('listTemplates + findPack resolve by name and key, tagged source=design', () => {
  const list = design.listTemplates();
  assert.ok(list.map(t => t.id).includes('acme-brand'));
  assert.ok(list.every(t => t.source === 'design'));
  assert.ok(design.findPack('acme-brand'));
  assert.ok(design.findPack('acme-brand@1'));
  assert.equal(design.findPack('nope'), null);
});

test('get tokens/guide/manifest and a component after registering it', () => {
  const dir = path.join(design.designRoot(), 'acme-brand');
  fs.writeFileSync(path.join(dir, 'components', 'button.html'),
    '<button class="btn" style="background:var(--ui-action);border-radius:var(--ui-radius-control)">Go</button>\n');
  setComponents('acme-brand', [{ id: 'button', file: 'components/button.html', variants: ['primary', 'quiet'] }]);

  assert.ok(design.getArtifact('acme-brand', 'tokens').includes('--ui-action'));
  assert.ok(design.getArtifact('acme-brand', 'guide').includes('## Source map'));
  assert.ok(design.getArtifact('acme-brand', 'manifest').includes('acme-brand'));
  assert.ok(design.getArtifact('acme-brand', 'button').includes('<button'));
  assert.throws(() => design.getArtifact('acme-brand', 'button', { variant: 'nope' }), /unknown variant/);
  assert.throws(() => design.getArtifact('acme-brand', 'ghost'), /unknown artifact/);
  assert.equal(design.validateTemplate('acme-brand').valid, true);
});

test('validateTemplate flags a missing component file and warns on raw colors', () => {
  const dir = path.join(design.designRoot(), 'acme-brand');
  setComponents('acme-brand', [{ id: 'button', file: 'components/button.html' }, { id: 'ghost', file: 'components/ghost.html' }]);
  const v = design.validateTemplate('acme-brand');
  assert.ok(!v.valid);
  assert.ok(v.errors.some(e => /component file missing/.test(e)));

  fs.writeFileSync(path.join(dir, 'components', 'raw.html'), '<div style="color:#ffffff">x</div>');
  setComponents('acme-brand', [{ id: 'button', file: 'components/button.html' }, { id: 'raw', file: 'components/raw.html' }]);
  const v2 = design.validateTemplate('acme-brand');
  assert.ok(v2.valid, 'valid despite raw color (only a warning)');
  assert.ok(v2.warnings.some(w => /raw color/.test(w)));
});

test('promoteFromProject builds a template from a project UI.md + token source', () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'jg-proj-'));
  fs.mkdirSync(path.join(proj, '.jonggrang'), { recursive: true });
  fs.mkdirSync(path.join(proj, 'src', 'theme'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'src', 'theme', 'tokens.css'), ':root{--ui-action:oklch(0.4 0.1 255)}');
  const guide = '---\nformat: jonggrang-ui-guide/v1\nbaseline: existing-project\ntoken_source: src/theme/tokens.css\ntoken_status: ready\ndescription: My promoted system\n---\n\n' +
    ui.REQUIRED_GUIDE_SECTIONS.map(s => '## ' + s + '\n\nbody').join('\n\n') + '\n';
  fs.writeFileSync(path.join(proj, '.jonggrang', 'UI.md'), guide);

  const r = design.promoteFromProject('promoted-sys', proj);
  assert.ok(fs.existsSync(path.join(r.dir, 'tokens.css.template')));
  assert.equal(r.tokenSource, 'src/theme/tokens.css');
  assert.ok(design.getArtifact('promoted-sys', 'tokens').includes('--ui-action'));
  // guide-fragment is the body only (frontmatter stripped)
  assert.ok(!design.getArtifact('promoted-sys', 'guide').includes('format: jonggrang-ui-guide'));
  assert.equal(design.validateTemplate('promoted-sys').valid, true);
});

test('removeTemplate deletes it', () => {
  design.newTemplate('temp-x');
  assert.ok(design.findPack('temp-x'));
  design.removeTemplate('temp-x');
  assert.equal(design.findPack('temp-x'), null);
});
