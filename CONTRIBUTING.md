# Contributing to Jonggrang

You found this. That means you either broke something, want to build something, or just like reading contribution guides (weird flex, but okay).

Here's how to make it painless for you, for us, and for the AI agents who will eventually review your PR.

---

## Core Principles

Jonggrang exists to **discipline AI coding agents**. So yes, we eat our own dog food. This codebase is held to the same standards. Every contribution should:

1. **Start with an issue** — discuss before coding. PRs that materialize from the void make us nervous.
2. **One PR, one concern** — don't sneak three features, two bugfixes, and a refactor into one PR. We see you.
3. **Test when you can** — especially for `lib/` and logic changes. AI agents are good at writing tests. Use them.
4. **Update docs** — if you change behavior and the docs still say the old thing, you just created a time bomb for the next person.

---

## Quick Setup

```bash
git clone git@github.com:porcupine-md/jonggrang.git
cd jonggrang
make install
make build
```

→ [Full development setup guide](docs/QUICKSETUP.md)

---

## Contribution Workflow

### 1. Pick or open an issue

Check [GitHub Issues](https://github.com/porcupine-md/jonggrang/issues). If nothing fits, open a new one. Tell us:
- What you want to change/fix
- Why anyone should care
- For features: what "done" looks like

### 2. Branch

```bash
git checkout -b feat/feature-name     # new feature
git checkout -b fix/bug-name          # bugfix
git checkout -b docs/whats-updated    # documentation
```

### 3. Commit

We use a **structured commit convention** so git history doubles as an agent communication layer — a fresh-context agent can recover *why* a change was made, not just *what* changed. See [`docs/COMMIT-CONVENTION.md`](docs/COMMIT-CONVENTION.md) for the full reference.

**Agent commits are a contract** (enforced by a lifecycle hook). **Human commits are exempt** but encouraged to follow.

```
<type>: <summary>

Context: <feature/plan this belongs to, narrative — not an ID>
What: <the change intent in prose — don't list files, MANIFEST tracks that>
Why: <rationale for the change>
Tradeoff: <what was sacrificed, or "none">
Caveats: <what the next agent should know, or "none">

Co-authored-by: jonggrang <koko@jonggrang.dev>
```

All 5 fields are required for agent commits — use `none` if genuinely N/A (typo fixes, version bumps). The `Co-authored-by:` trailer (auto-injected) marks a commit as agent-authored and triggers validation.

Commit messages in **English please**. Doesn't need to be Shakespeare — just clear enough that an agent six months from now can rebuild your rationale.

### 4. Test & check

```bash
npm test            # run test suite
npm run check       # syntax + structure check
```

### 5. Open a Pull Request

Your PR description should answer three questions:
- **What** — what actually changed
- **Why** — what would break if we didn't do this
- **How to test** — give us a script, a command, something we can copy-paste

We'll review within 1-3 business days. If it takes longer, we're either on vacation or the AI agents staged a coup.

---

## Technical Guide

### Where to touch what

| Area | File | When you want to... |
|------|------|-------------------|
| New CLI command | `bin/jonggrang.js`, `lib/jonggrang.js` | Add `jonggrang xyz` |
| Orchestration phase | `lib/orchestration.js` | Change how work flows |
| Hook system | `hooks/{claude,opencode,pi}/` | Add enforcement rules |
| Core skill | `skills/core/<name>/SKILL.md` | Add a prompt template |
| Library skill | `skills/library/<domain>/<name>/SKILL.md` | Add domain knowledge |
| Dashboard UI | `client/src/` | Change the web UI |
| Dashboard API | `server.js` | Add endpoints |
| Init templates | `templates/` | Change what `jonggrang init` spits out |
| Documentation | `docs/` | Fix typos, translate, add guides |

### How to write a skill

Skills are markdown files that teach AI agents how to do things. Here's the format:

```markdown
---
name: skill-name
description: What this skill does — be specific
type: scaffold
tier: core
project_types: [web-app, api]
trigger: "keywords that should activate this skill"
---

## Context
What the agent needs to know before starting.

## Instructions
1. Do this first
2. Then this

## Validation
- [ ] This must be true when the skill is done
```

### Code style (or: how to not make Ibnu sigh)

- **Plain JavaScript** unless you're in `hooks/pi/` (that one's TypeScript, don't fight it)
- **Small functions, single purpose** — if your function does three things, it's three functions wearing a trench coat
- **Name things like you mean it** — `compactionGate.js` > `util2.js`
- **Comment sparingly** — if you need a paragraph to explain what a function does, the function name is wrong

---

## Stuck?

Open a [GitHub Issue](https://github.com/porcupine-md/jonggrang/issues) or ping a maintainer. We don't bite. The AI agents might, but we keep them on a leash.

---

## License

By contributing, you agree your work falls under the same [MIT License](LICENSE). That means anyone can use it, sell it, or build it into their thing — just don't sue us if something breaks.
