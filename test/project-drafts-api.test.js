'use strict';

// Project dashboard/API must follow the same per-session draft contract as the
// CLI: pending plans live at .jonggrang/.drafts/<session>/plan.md, not at the
// legacy root .jonggrang/plan.md.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');

const lib = require('../lib/jonggrang');
const planRoutes = require('../apis/projects/plan');
const approveRoutes = require('../apis/projects/approve');

function writeDraft(root, sid, content) {
  const dir = lib.draftDirFor(root, sid);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(lib.draftFileFor(root, sid), content);
}

async function withServer(root, fn) {
  const project = { id: 'p1', path: root };
  const spawned = [];
  const deps = {
    fs,
    path,
    webState: { getProject: (id) => (id === 'p1' ? project : null) },
    orchestration: { readManifest: () => null },
    spawnForProject: (_project, args) => { spawned.push(args); return { on() {} }; },
    wireProjectProcess: () => {},
  };

  const app = express();
  app.use(express.json());
  app.use('/api/projects', planRoutes(deps));
  app.use('/api/projects', approveRoutes(deps));

  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base, spawned);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('project API lists all pending drafts by session id', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jong-project-api-'));
  try {
    writeDraft(root, 'draft-one', '---\nfeature: one\n---\n# Plan One');
    writeDraft(root, 'draft-two', '---\nfeature: two\n---\n# Plan Two');

    await withServer(root, async (base) => {
      const res = await fetch(`${base}/api/projects/p1/plans`);
      assert.equal(res.status, 200);
      const plans = await res.json();
      const drafts = plans.filter(p => p.status === 'draft');
      assert.equal(drafts.length, 2);
      assert.deepEqual(new Set(drafts.map(p => p.id)), new Set(['draft-one', 'draft-two']));
      assert.ok(drafts.every(p => p.sessionId === p.id));
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('project API edits only the requested draft session', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jong-project-api-'));
  try {
    writeDraft(root, 'draft-one', '# One');
    writeDraft(root, 'draft-two', '# Two');

    await withServer(root, async (base) => {
      const res = await fetch(`${base}/api/projects/p1/plan`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 'draft-one', content: '# One edited' }),
      });
      assert.equal(res.status, 200);
      assert.equal(fs.readFileSync(lib.draftFileFor(root, 'draft-one'), 'utf8'), '# One edited');
      assert.equal(fs.readFileSync(lib.draftFileFor(root, 'draft-two'), 'utf8'), '# Two');
      assert.ok(!fs.existsSync(path.join(root, '.jonggrang', 'plan.md')),
        'editing a draft must not recreate the legacy root plan.md');
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('project approve endpoint passes the selected draft session to the CLI', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jong-project-api-'));
  try {
    writeDraft(root, 'draft-one', '# One');
    writeDraft(root, 'draft-two', '# Two');

    await withServer(root, async (base, spawned) => {
      const res = await fetch(`${base}/api/projects/p1/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 'draft-one' }),
      });
      assert.equal(res.status, 202);
      assert.deepEqual(spawned[0], ['approve', '--session', 'draft-one']);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
