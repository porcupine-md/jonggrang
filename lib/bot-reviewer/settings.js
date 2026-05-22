'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { text, select, confirm, isCancel, cancel, intro, outro, spinner, note } = require('@clack/prompts');
const { resolveAgentDir, resolveAuthPath } = require('./auth');

const SETTINGS_FILE = path.join(os.homedir(), '.jonggrang', 'bot-reviewer.json');
const STATE_FILE    = path.join(os.homedir(), '.jonggrang', 'bot-reviewer-state.json');

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch {}
  return {};
}

function saveSettings(settings) {
  const dir = path.dirname(SETTINGS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {}
  return {};
}

function saveState(state) {
  const dir = path.dirname(STATE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

async function resolveAuthAndRegistry() {
  const { AuthStorage, ModelRegistry, ENV_AGENT_DIR } = await import('@earendil-works/pi-coding-agent');
  process.env[ENV_AGENT_DIR] = resolveAgentDir();
  const authStorage = AuthStorage.create(resolveAuthPath());
  return ModelRegistry.create(authStorage);
}

// ── Settings wizard ───────────────────────────────────────────────────────────

async function cmdBotReviewerSettings() {
  intro('Jonggrang Bot Reviewer — Settings');

  const current   = loadSettings();
  const curGitlab = current.gitlab || {};

  // ── Model selection (uses jonggrang / Pi configured credentials) ──────────
  const s = spinner();
  s.start('Loading configured models…');
  let availableModels = [];
  try {
    const registry = await resolveAuthAndRegistry();
    availableModels = registry.getAvailable();
    s.stop(`Found ${availableModels.length} configured model(s)`);
  } catch (e) {
    s.stop('Could not load models');
    console.error(`  ${e.message}`);
    console.error('  Run `jonggrang login` to configure a provider first.');
    outro('Settings not saved.');
    return;
  }

  if (availableModels.length === 0) {
    outro('No models configured. Run `jonggrang login` then `jonggrang model` first.');
    return;
  }

  const modelOptions = availableModels.map(m => ({
    value: JSON.stringify({ provider: m.provider.id || m.provider, model: m.id }),
    label: m.name || m.id,
    hint:  String(m.provider.id || m.provider),
  }));

  const currentModelVal = current.provider && current.model
    ? JSON.stringify({ provider: current.provider, model: current.model })
    : undefined;

  const pickedModel = await select({
    message: 'Select AI model for reviews',
    options: modelOptions,
    initialValue: currentModelVal,
  });
  if (isCancel(pickedModel)) { cancel('Cancelled'); return; }

  const { provider: selectedProvider, model: selectedModel } = JSON.parse(pickedModel);

  // ── GitLab URL ────────────────────────────────────────────────────────────
  const gitlabUrl = await text({
    message: 'GitLab URL',
    placeholder: 'https://gitlab.com',
    initialValue: curGitlab.url || 'https://gitlab.com',
  });
  if (isCancel(gitlabUrl)) { cancel('Cancelled'); return; }

  // ── GitLab Token ──────────────────────────────────────────────────────────
  const gitlabToken = await text({
    message: 'GitLab API token (Personal Access Token with api scope)',
    placeholder: 'glpat-xxxxxxxxxxxxxxxxxxxx',
    initialValue: curGitlab.token || '',
  });
  if (isCancel(gitlabToken)) { cancel('Cancelled'); return; }

  // ── Verify token ──────────────────────────────────────────────────────────
  s.start('Verifying GitLab token…');
  let gitlabUser;
  try {
    const { GitLabClient } = require('./gitlab');
    const client = new GitLabClient(gitlabToken, gitlabUrl);
    gitlabUser = await client.getCurrentUser();
    s.stop(`✓ Authenticated as ${gitlabUser.name} (@${gitlabUser.username})`);
  } catch (e) {
    s.stop('✗ Token verification failed');
    console.error(`  ${e.message}`);
    outro('Settings not saved.');
    return;
  }

  // ── Repo selection ────────────────────────────────────────────────────────
  const repos = [...(curGitlab.repos || [])];

  if (repos.length > 0) {
    console.log('\nCurrently monitored repos:');
    repos.forEach(r => console.log(`  • ${r.name}`));
    const keepAll = await confirm({ message: 'Keep existing repo list?' });
    if (isCancel(keepAll)) { cancel('Cancelled'); return; }
    if (!keepAll) repos.length = 0;
  }

  let addMore = true;
  while (addMore) {
    const searchQuery = await text({
      message: repos.length
        ? `Search to add more repos (${repos.length} selected — leave empty to finish)`
        : 'Search repos to monitor (by name or namespace/project)',
      placeholder: 'my-project',
    });
    if (isCancel(searchQuery)) { cancel('Cancelled'); return; }
    if (!searchQuery?.trim()) { addMore = false; break; }

    s.start('Searching GitLab…');
    let projects = [];
    try {
      const { GitLabClient } = require('./gitlab');
      const client = new GitLabClient(gitlabToken, gitlabUrl);
      projects = await client.searchProjects(searchQuery.trim());
      s.stop(`Found ${projects.length} project(s)`);
    } catch (e) {
      s.stop('Search failed');
      console.error(`  ${e.message}`);
      continue;
    }

    if (projects.length === 0) {
      console.log('  No projects found. Try a different search term.');
      continue;
    }

    const options = [
      ...projects.map(p => ({
        value: JSON.stringify({ id: p.id, name: p.path_with_namespace }),
        label: p.path_with_namespace,
        hint:  p.description ? p.description.slice(0, 60) : '',
      })),
      { value: '__back__', label: '↩  Search again' },
    ];

    const picked = await select({ message: 'Select project to add', options });
    if (isCancel(picked) || picked === '__back__') continue;

    const repo = JSON.parse(picked);
    if (!repos.find(r => r.id === repo.id)) {
      repos.push(repo);
      console.log(`  ✓ Added ${repo.name}`);
    } else {
      console.log(`  Already in list: ${repo.name}`);
    }

    const another = await confirm({ message: 'Add another repo?' });
    if (isCancel(another) || !another) addMore = false;
  }

  if (repos.length === 0) {
    outro('No repos selected. Settings not saved.');
    return;
  }

  // ── Poll interval ─────────────────────────────────────────────────────────
  const pollStr = await text({
    message: 'Poll interval in seconds',
    placeholder: '60',
    initialValue: String(current.poll_interval || 60),
  });
  if (isCancel(pollStr)) { cancel('Cancelled'); return; }

  // ── Save ──────────────────────────────────────────────────────────────────
  saveSettings({
    provider:      selectedProvider,
    model:         selectedModel,
    gitlab:        { url: gitlabUrl, token: gitlabToken, repos },
    poll_interval: Math.max(10, parseInt(pollStr) || 60),
  });

  note(
    [
      `Model:    ${selectedModel} (${selectedProvider})`,
      '',
      ...repos.map(r => `• ${r.name}`),
    ].join('\n'),
    'Configuration',
  );
  outro(`Settings saved → ${SETTINGS_FILE}`);
}

module.exports = { cmdBotReviewerSettings, loadSettings, loadState, saveState };
