'use strict';

const crypto = require('crypto');
const { cmdBotReviewerSettings, loadSettings, loadState, saveState } = require('./settings');
const { GitLabClient } = require('./gitlab');
const { reviewDiff, MAX_DIFF_CHARS }   = require('./reviewer');

// ── Entry point ───────────────────────────────────────────────────────────────

async function runBotReviewer(subArgs) {
  const platform = subArgs[0];

  if (!platform || platform === 'help' || platform === '--help') {
    console.log([
      'Usage: jonggrang bot-reviewer <subcommand> [options]',
      '',
      'Subcommands:',
      '  gitlab          Watch for new commits on open MRs and review them',
      '  gitlab --scan   Scan all currently open MRs and review unreviewed ones',
      '  settings        Configure model, token, and repos to monitor',
      '',
      'Examples:',
      '  jonggrang bot-reviewer settings       # first-time setup',
      '  jonggrang bot-reviewer gitlab         # watch mode (new commits only)',
      '  jonggrang bot-reviewer gitlab --scan  # scan all open MRs',
    ].join('\n'));
    return;
  }

  if (platform === 'settings') {
    return cmdBotReviewerSettings();
  }

  if (platform === 'gitlab') {
    const scanMode = subArgs.includes('--scan');
    return runGitLabBot(scanMode);
  }

  console.error(`Unknown subcommand: ${platform}`);
  console.error("Run 'jonggrang bot-reviewer help' for usage.");
  process.exit(1);
}

// ── GitLab bot ────────────────────────────────────────────────────────────────

async function runGitLabBot(scanMode = false) {
  const settings = loadSettings();

  if (!settings.gitlab?.token) {
    console.error('Bot reviewer not configured. Run: jonggrang bot-reviewer settings');
    process.exit(1);
  }

  if (!settings.provider || !settings.model) {
    console.error('AI model not configured. Run: jonggrang bot-reviewer settings');
    process.exit(1);
  }

  const repos   = settings.gitlab.repos || [];
  const pollMs  = Math.max(10, settings.poll_interval || 60) * 1000;
  const client  = new GitLabClient(settings.gitlab.token, settings.gitlab.url);

  if (repos.length === 0) {
    console.error('No repos configured. Run: jonggrang bot-reviewer settings');
    process.exit(1);
  }

  const modeLabel = scanMode ? 'scan (all open MRs)' : 'watch (new commits only)';
  console.log(`\n🤖 Jonggrang Bot Reviewer — GitLab`);
  console.log(`   Model:     ${settings.model} (${settings.provider})`);
  console.log(`   Mode:      ${modeLabel}`);
  console.log(`   Polling:   every ${pollMs / 1000}s`);
  console.log(`   Repos (${repos.length}):`);
  repos.forEach(r => console.log(`     • ${r.name}`));
  console.log('   Press Ctrl+C to stop\n');

  const { provider, model } = settings;
  let state = loadState();

  const poll = async () => {
    for (const repo of repos) {
      try {
        await processRepo(client, provider, model, repo, state, scanMode);
      } catch (e) {
        console.error(`[${repo.name}] Unhandled error: ${e.message}`);
      }
    }
    saveState(state);
  };

  // Run immediately, then on interval
  await poll();
  const timer = setInterval(poll, pollMs);

  process.on('SIGINT', () => {
    clearInterval(timer);
    saveState(state);
    console.log('\nBot reviewer stopped.');
    process.exit(0);
  });
}

// ── Per-repo processing ───────────────────────────────────────────────────────

async function processRepo(client, provider, model, repo, state, scanMode = false) {
  const mrs       = await client.getOpenMRs(repo.id);
  const repoState = state[repo.id] || {};

  for (const mr of mrs) {
    const key     = String(mr.iid);
    const prev    = repoState[key];

    if (scanMode) {
      // --scan: skip MRs already successfully reviewed
      if (prev && !prev.error) continue;
    } else {
      // default watch mode: skip only if this exact commit was already reviewed
      if (prev && !prev.error && prev.head_sha === mr.sha) continue;
    }

    const tag     = `[${repo.name} !${mr.iid}]`;
    const isReview = prev && prev.head_sha && prev.head_sha !== mr.sha;
    console.log(`${tag} ${isReview ? 'Re-reviewing (new commit):' : 'Reviewing:'} ${mr.title}`);

    try {
      const changes  = await client.getMRChanges(repo.id, mr.iid);
      const diffText = buildDiff(changes.changes || []);

      if (!diffText.trim()) {
        console.log(`${tag} → Empty diff, skipping`);
        repoState[key] = { reviewed_at: now(), skipped: true };
        continue;
      }

      const review = await reviewDiff(diffText, mr.title, mr.description, provider, model);

      // Post summary as a general MR note
      await client.postMRNote(repo.id, mr.iid, buildNote(review));

      // Post inline comments where we have file + line info
      const versions = await client.getMRVersions(repo.id, mr.iid).catch(() => []);
      const latest   = versions[0];

      if (latest && review.issues?.length) {
        for (const issue of review.issues) {
          if (!issue.file || !issue.line) continue;
          const lineCode = gitlabLineCode(issue.file, 0, issue.line);
          await client.postMRDiscussion(
            repo.id, mr.iid,
            `**[${issue.severity}]** ${issue.message}`,
            {
              base_sha:      latest.base_commit_sha,
              start_sha:     latest.start_commit_sha,
              head_sha:      latest.head_commit_sha,
              position_type: 'text',
              old_path:      issue.file,
              new_path:      issue.file,
              new_line:      issue.line,
              line_code:     lineCode,
            },
          ).catch(e => console.log(`${tag} Inline comment skipped (${issue.file}:${issue.line ?? '?'}): ${e.message}`));
        }
      }

      repoState[key] = {
        reviewed_at:  now(),
        verdict:      review.verdict,
        issues_count: review.issues?.length ?? 0,
        head_sha:     mr.sha,
      };

      const cnt = review.issues?.length ?? 0;
      console.log(`${tag} → ${review.verdict} | ${cnt} issue(s) posted`);
    } catch (e) {
      console.error(`${tag} Review failed: ${e.message}`);
      repoState[key] = { reviewed_at: now(), error: e.message };
    }
  }

  state[repo.id] = repoState;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// GitLab line_code format: sha1(path)_oldLine_newLine
function gitlabLineCode(filePath, oldLine, newLine) {
  const hash = crypto.createHash('sha1').update(filePath).digest('hex');
  return `${hash}_${oldLine}_${newLine}`;
}

function buildDiff(changes) {
  return changes
    .map(c => `diff --git a/${c.old_path} b/${c.new_path}\n${c.diff || ''}`)
    .join('\n')
    .slice(0, MAX_DIFF_CHARS);
}

const VERDICT_EMOJI = { APPROVED: '✅', CHANGES_REQUESTED: '❌', COMMENT: '💬' };

function buildNote(review) {
  const emoji = VERDICT_EMOJI[review.verdict] ?? '💬';
  const issues = review.issues || [];

  const critical  = issues.filter(i => i.severity === 'CRITICAL' || i.severity === 'HIGH');
  const criticalSet = new Set(critical);
  const security  = issues.filter(i => i.type === 'security' && !criticalSet.has(i));
  const remaining = issues.filter(i => !criticalSet.has(i) && i.type !== 'security');

  const section = (title, items) => items.length
    ? `### ${title}\n${items.map(i => `- **${i.severity}** \`${i.file}:${i.line ?? '?'}\` — ${i.message}`).join('\n')}\n`
    : '';

  return [
    `## ${emoji} Jonggrang Bot Review`,
    '',
    `**Verdict:** ${review.verdict}`,
    '',
    review.summary,
    '',
    section('🚨 Critical / High Issues', critical),
    section('🔒 Security Issues', security),
    section('📝 Other Issues', remaining),
    `---`,
    `*Reviewed by Jonggrang Bot • ${now()}*`,
  ].join('\n');
}

const now = () => new Date().toISOString();

module.exports = { runBotReviewer };
