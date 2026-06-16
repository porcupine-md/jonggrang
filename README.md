# Jonggrang

> AI agents write code fast. Too fast. Jonggrang makes sure they don't make a mess while doing it.

Jonggrang is a CLI tool that puts AI coding agents through a **Plan → Implement → Simplify → Test → Review** pipeline. It breaks features into atomic tasks, runs each one with a fresh agent, and refuses to let anything through until the quality gates are green.

Works with four AI backends: [OpenCode](https://opencode.ai/), [Claude Code](https://claude.ai/code), [OpenAI Codex CLI](https://github.com/openai/codex), and **Jonggrang** (built on [Pi SDK](https://pi.dev/)). Pick your poison.

---

## What Makes It Different

AI agents write code fast. Too fast. The bottleneck isn't speed — it's **knowing when to stop and clean up.**

Jonggrang enforces a pipeline where every feature passes through the same gates: Plan → Implement → Simplify → Test → Review. Not because every step is always necessary, but because skipping steps is how complexity accumulates silently.

**Fresh context per task.** Each task starts with a clean agent instance. No stale assumptions carrying forward. **Hooks police in real-time** — secrets blocked, context overload prevented, exit refused until quality gates pass. **Simplify phase** revisits every changed file to reduce complexity before the PR opens.

Left unchecked, an AI agent will always take the shortest path — even if that path goes through a minefield. Jonggrang puts up the guardrails.

→ [Read the full philosophy & architecture](docs/PHILOSOPHY.md)

---

## 🚀 I Just Want to Use It

Five commands. That's all you need.

```bash
# In your project directory:
jonggrang init
jonggrang plan "what you want to build"    # AI writes a plan — you review it
jonggrang approve                          # Decompose plan into tasks
jonggrang work                             # Execute tasks one by one
jonggrang review                           # Comprehensive code review
```

**One-shot shortcut:**
```bash
jonggrang work "REST API for todo management" --yes
```

**Interactive chat:**
```bash
jonggrang agent    # Full TUI chat with /plan, /work, /review, etc.
```

→ [Step-by-step guide for beginners](docs/QUICKSTART.md)

---

## 🔧 I Want to Hack on It

Come on in. The water's fine.

```bash
git clone <repo-url> && cd jonggrang
make install
make build
```

Project entry points: CLI binary, Pi TUI extension, web dashboard server. Hooks live in `hooks/`, skills in `skills/`, orchestration engine reads `MANIFEST.yaml`.

→ [Full development setup guide](docs/QUICKSETUP.md)

---

## Commands at a Glance

| Command | What it does |
|---------|-------------|
| `jonggrang init` | Interactive wizard — sets up `.jonggrang/`, `AGENTS.md`, hooks, skills |
| `jonggrang plan "desc"` | AI writes `.jonggrang/plan.md` — human reviews before code |
| `jonggrang approve` | Decomposes plan into atomic tasks in `jonggrang-tasks.json` |
| `jonggrang work` | Executes task queue with fresh context per task |
| `jonggrang status` | Shows task board |
| `jonggrang review` | Comprehensive code review → markdown report |
| `jonggrang agent` | Full TUI chat session with `/plan`, `/work`, `/review` commands |
| `jonggrang web` | Visual Kanban dashboard with real-time logs + parallel run (one worktree/branch per plan, review & push per branch) |
| `jonggrang manifest` | Inspect output files tracked per phase (`list`, `show [id]`, `add`) |

```bash
# Quick flags
jonggrang plan "feature" --yes       # Skip review, auto-approve
jonggrang work "feature" --yes       # Full pipeline in one command
jonggrang plan "feature" --deep      # 3-phase deep analysis (risks, alternatives)
jonggrang work --mode autonomous     # Override autonomy mode
jonggrang work --task task-003       # Execute specific task only
```

---

## Requirements

- **Node.js** (latest LTS)
- **An AI agent** — pick one:
  - [OpenCode](https://opencode.ai/) → `curl -fsSL https://opencode.ai/install | bash`
  - [Claude Code](https://docs.anthropic.com/en/docs/claude-code) → `npm install -g @anthropic-ai/claude-code`
  - [OpenAI Codex CLI](https://github.com/openai/codex) → `npm install -g @openai/codex`
  - Jonggrang (Pi SDK) → `npm install -g @earendil-works/pi-coding-agent`
- [jq](https://jqlang.github.io/jq/) → `brew install jq`
- git

---

## Configuration

```jsonc
// .jonggrang/jonggrang.json (after init)
{
  "tool": "opencode",          // opencode | claude | jonggrang | codex
  "mode": { "autonomy": "balanced" },
  "work": { "max_iterations": 10 }
}
```

Two-layer config: `~/.jonggrang/settings.json` (your defaults) → `.jonggrang/jonggrang.json` (this project's quirks).

→ [Full config reference](docs/CONFIG.md)

---

## 📚 More Reading

| Doc | When you want to... |
|-----|---------|
| [QUICKSTART.md](docs/QUICKSTART.md) | Get building in 5 minutes |
| [QUICKSETUP.md](docs/QUICKSETUP.md) | Set up your dev environment |
| [PHILOSOPHY.md](docs/PHILOSOPHY.md) | Understand why this thing exists |
| [JONGGRANG.md](docs/JONGGRANG.md) | Read the full blueprint |
| [WORKFLOW.md](docs/WORKFLOW.md) | Grok the 16-phase pipeline |
| [SKILLS.md](docs/SKILLS.md) | Teach the agents new tricks |
| [CONFIG.md](docs/CONFIG.md) | Tweak every knob |

---

## Contributors

- **[Eka Irawan (Ibnu)](https://github.com/anak10thn)** + **[Ahmad Anshorimuslim Syuhada (Ans)](https://github.com/ans-4175)**

→ [Full credits & backstory](AUTHORS.md)

---

## License

MIT © Porcupine Team

See [LICENSE](LICENSE) for full text. TL;DR: **free to use for anything, including commercial, with no warranty. Contributors are protected from liability.**
