# Jonggrang

> AI Development Workflow Orchestrator — from idea to production-ready code.

Jonggrang is a CLI tool that orchestrates AI coding agents through a disciplined **Plan → Implement → Simplify → Test → Review** pipeline. It decomposes features into atomic tasks and executes them one-by-one with a fresh agent per task — no accumulated confusion, no drifting context.

Supports four AI Coding Agents: [OpenCode](https://opencode.ai/), [Claude Code](https://claude.ai/code), [OpenAI Codex CLI](https://github.com/openai/codex), and **Jonggrang** (built on [Pi SDK](https://pi.dev/) — multi-provider, TypeScript-extensible).

---

## What Makes It Different

AI agents write code fast. Too fast. The bottleneck isn't speed — it's **knowing when to stop and clean up.**

Jonggrang enforces a pipeline where every feature passes through the same gates: Plan → Implement → Simplify → Test → Review. Not because every step is always necessary, but because skipping steps is how complexity accumulates silently.

**Fresh context per task.** Each task starts with a clean agent instance. No stale assumptions carrying forward. **Hooks police in real-time** — secrets blocked, context overload prevented, exit refused until quality gates pass. **Simplify phase** revisits every changed file to reduce complexity before the PR opens.

The agent will always take the shortest path. Jonggrang makes sure the shortest path is also the right one.

→ [Read the full philosophy & architecture](docs/PHILOSOPHY.md)

---

## I Just Want to Use It

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

## I Want to Set Up for Development

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
| `jonggrang web` | Visual Kanban dashboard with real-time logs |

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

Two-layer: `~/.jonggrang/settings.json` (global) → `.jonggrang/jonggrang.json` (project overrides).

→ [Full config reference](docs/CONFIG.md)

---

## Documentation

| Doc | Content |
|-----|---------|
| [QUICKSTART.md](docs/QUICKSTART.md) | Beginner's step-by-step guide |
| [QUICKSETUP.md](docs/QUICKSETUP.md) | Development setup for contributors |
| [PHILOSOPHY.md](docs/PHILOSOPHY.md) | Philosophy, pipeline, architecture deep-dive |
| [JONGGRANG.md](docs/JONGGRANG.md) | Full specification |
| [WORKFLOW.md](docs/WORKFLOW.md) | Detailed workflow documentation |
| [SKILLS.md](docs/SKILLS.md) | Skill system reference |
| [CONFIG.md](docs/CONFIG.md) | Configuration reference |

---

## Contributors

Jonggrang dibuat dan dikelola oleh:

- **[Eka Irawan (Ibnu)](https://github.com/anak10thn)**
- **[Ahmad Anshorimuslim Syuhada (Ans)](https://github.com/ans-4175)**

---

## License

MIT © Porcupine Team

Lihat [LICENSE](LICENSE) untuk teks lengkap. Ringkasannya: **bebas pakai untuk apa pun, termasuk komersial, tanpa garansi. Kontributor dilindungi dari tuntutan.**
