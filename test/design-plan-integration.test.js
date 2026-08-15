const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jg-di-'));
process.env.JONGGRANG_HOME = TMP;
const design = require('../lib/design');
const ui = require('../lib/ui-context');

const KEY = 'acme-brand@1';

test('a personal design template is discoverable + loadable via the plan pack API', () => {
  design.newTemplate('acme-brand', { intent: 'Acme brand', product_shapes: ['dashboard'], recommend_keywords: ['acme', 'brand'] });

  // merged catalog: personal template + built-ins both present
  const keys = ui.baselineKeys();
  assert.ok(keys.includes(KEY), 'baselineKeys() includes personal template');
  assert.ok(keys.includes('landing-page-minimalist@1'), 'built-ins still present in merged catalog');
  assert.ok(ui.isBaselineKey(KEY), 'isBaselineKey() true for personal template');

  // explicit baseline in a request resolves to the personal template (the --yes/--no-ask path)
  assert.equal(ui.recommendBaseline('please use acme-brand@1 for this'), KEY);

  // loadable, with shared core/ resolved and design source tagged
  const pack = ui.loadBaselinePack(KEY);
  assert.equal(pack.source, 'design');
  assert.ok(pack.tokenTemplate.includes('--ui-action'), 'token template loaded');
  assert.ok(pack.guideSections.includes('UI guide sections'), 'shared core guide-sections resolved');
  assert.ok(pack.semanticTokenContract.length > 0, 'shared core semantic-token-contract resolved');
});

test('explicit built-in catalog stays scoped (no personal leakage)', () => {
  const builtins = ui.baselineKeys(ui.baselineCatalogPath());
  assert.ok(builtins.includes('landing-page-minimalist@1'));
  assert.ok(!builtins.includes(KEY), 'explicit built-in catalog excludes personal templates');
});

test('a broken personal template does not break built-in discovery', () => {
  // create an invalid template (missing token file) directly
  const dir = path.join(design.designRoot(), 'broken');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.yml'), 'id: broken\nversion: 1\nintent: x\nproduct_shapes: [any]\nguide_fragment: guide-fragment.md\ntoken_template: tokens.css.template\n');
  // no guide/token files → invalid; merged listing must still expose valid built-ins
  const validKeys = ui.baselineKeys();
  assert.ok(validKeys.includes('landing-page-minimalist@1'));
  assert.ok(!validKeys.includes('broken@1'), 'invalid personal template excluded from valid keys');
});
