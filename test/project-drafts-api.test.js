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

// A draft mid Pass-A: plan-questions.json present, plan.md not yet written.
function writeQuestions(root, sid, payload) {
  const dir = lib.draftDirFor(root, sid);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(lib.questionsFileFor(root, sid), JSON.stringify(payload));
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

test('plan questions endpoint resolves the pending-questions draft (no plan.md yet)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jong-project-api-'));
  try {
    // Mid Pass-A: questions written into the draft folder, no plan.md.
    writeQuestions(root, 'draft-pending', {
      goal_analysis: 'clarify me',
      questions: [{ id: 'q1', question: 'Which UI?', type: 'text' }],
    });

    await withServer(root, async (base) => {
      const res = await fetch(`${base}/api/projects/p1/plan/questions`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.exists, true);
      assert.equal(body.sessionId, 'draft-pending');
      assert.equal(body.goal_analysis, 'clarify me');
      assert.equal(body.questions.length, 1);
      assert.ok(!fs.existsSync(path.join(root, '.jonggrang', 'plan-questions.json')),
        'must not read the legacy root singleton');
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('plan questions endpoint honors an explicit ?session override', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jong-project-api-'));
  try {
    writeQuestions(root, 'draft-a', { goal_analysis: 'A', questions: [{ id: 'q1', question: 'A?', type: 'text' }] });
    writeQuestions(root, 'draft-b', { goal_analysis: 'B', questions: [{ id: 'q1', question: 'B?', type: 'text' }] });

    await withServer(root, async (base) => {
      const res = await fetch(`${base}/api/projects/p1/plan/questions?session=draft-a`);
      const body = await res.json();
      assert.equal(body.sessionId, 'draft-a');
      assert.equal(body.goal_analysis, 'A');
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('plan questions endpoint returns exists:false when there are no questions', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jong-project-api-'));
  try {
    writeDraft(root, 'draft-plain', '# Plan, no questions');
    await withServer(root, async (base) => {
      const res = await fetch(`${base}/api/projects/p1/plan/questions`);
      const body = await res.json();
      assert.equal(body.exists, false);
      assert.deepEqual(body.questions, []);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('plan answers endpoint reuses the pending-questions draft via --session', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jong-project-api-'));
  try {
    writeQuestions(root, 'draft-pending', {
      goal_analysis: 'g', questions: [{ id: 'q1', question: 'Q?', type: 'text' }],
    });

    await withServer(root, async (base, spawned) => {
      const res = await fetch(`${base}/api/projects/p1/plan/answers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          description: 'build a thing',
          answers: [{ id: 'q1', value: 'modal' }],
        }),
      });
      assert.equal(res.status, 202);
      const args = spawned[0];
      // Reuses the pending draft rather than minting a new session → no orphans.
      const si = args.indexOf('--session');
      assert.ok(si !== -1, '--session must be passed');
      assert.equal(args[si + 1], 'draft-pending');
      assert.ok(args.includes('--answers-inline'), 'answers still passed inline');
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
