const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jg-api-'));
process.env.JONGGRANG_HOME = TMP;
const registerDesign = require('../apis/design');
const ui = require('../lib/ui-context');

let server, base;
const events = [];
const io = { emit: (name, payload) => events.push({ name, payload }) };

before(async () => {
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  registerDesign(app, io, {});
  await new Promise(resolve => { server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); }); });
});
after(() => { if (server) server.close(); });

async function req(method, url, body) {
  return fetch(base + url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
}

test('POST create + GET list', async () => {
  let res = await req('POST', '/api/design', { name: 'acme', intent: 'Acme', product_shapes: ['dashboard'] });
  assert.equal(res.status, 201);
  res = await req('GET', '/api/design');
  const { templates } = await res.json();
  assert.ok(templates.some(t => t.id === 'acme' && t.valid), 'acme listed and valid');
});

test('PUT component + manifest registers it; lints on save; emits change', async () => {
  let res = await req('PUT', '/api/design/acme/file', {
    file: 'components/button.html', content: '<button style="background:var(--ui-action)">Go</button>',
  });
  assert.equal(res.status, 200);
  const manifest = 'id: acme\nversion: 1\nintent: Acme\nproduct_shapes: [dashboard]\n' +
    'guide_fragment: guide-fragment.md\ntoken_template: tokens.css.template\n' +
    'components:\n  - id: button\n    file: components/button.html\n    variants: [primary]\n';
  res = await req('PUT', '/api/design/acme/file', { file: 'manifest.yml', content: manifest });
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.validation.valid, true);
  assert.ok(events.some(e => e.name === 'design.changed'), 'change event emitted');
});

test('PUT path guard rejects directory escape', async () => {
  const res = await req('PUT', '/api/design/acme/file', { file: '../evil.txt', content: 'x' });
  assert.equal(res.status, 400);
});

test('GET one + preview injects tokens and renders the component', async () => {
  let res = await req('GET', '/api/design/acme');
  const t = await res.json();
  assert.ok(t.components.some(c => c.id === 'button'));
  res = await req('GET', '/api/design/acme/preview?component=button&theme=dark&width=800');
  const html = await res.text();
  assert.match(res.headers.get('content-type') || '', /html/);
  assert.ok(html.includes('--ui-action'), 'tokens injected into preview');
  assert.ok(html.includes('<button'), 'component rendered');
  assert.ok(html.includes('data-theme="dark"'), 'theme applied');
});

test('validate endpoint returns valid', async () => {
  const v = await (await req('GET', '/api/design/acme/validate')).json();
  assert.equal(v.valid, true);
});

test('promote from a project via API', async () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'jg-p-'));
  fs.mkdirSync(path.join(proj, '.jonggrang'), { recursive: true });
  fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'src', 'tokens.css'), ':root{--ui-action:oklch(0.4 0.1 255)}');
  const guide = '---\nformat: jonggrang-ui-guide/v1\nbaseline: existing-project\ntoken_source: src/tokens.css\ntoken_status: ready\ndescription: promoted\n---\n\n' +
    ui.REQUIRED_GUIDE_SECTIONS.map(s => '## ' + s + '\n\nb').join('\n\n') + '\n';
  fs.writeFileSync(path.join(proj, '.jonggrang', 'UI.md'), guide);
  const res = await req('POST', '/api/design/promote', { name: 'promoted', fromProjectPath: proj });
  assert.equal(res.status, 201);
  const v = await (await req('GET', '/api/design/promoted/validate')).json();
  assert.equal(v.valid, true);
});

test('DELETE removes the template', async () => {
  const res = await req('DELETE', '/api/design/acme');
  assert.equal(res.status, 200);
  const { templates } = await (await req('GET', '/api/design')).json();
  assert.ok(!templates.some(t => t.id === 'acme'), 'acme gone');
});
