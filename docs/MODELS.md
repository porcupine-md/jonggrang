# Model & Effort Reference

Tool, model ID, and effort level reference for each Jonggrang backend.
Pass these as `--model <id>` and `--effort <level>` flags, or set in `jonggrang.json`.

---

## Claude Code (`--tool claude`)

### Model aliases

| Alias | Resolves to | Notes |
|---|---|---|
| `default` | Account tier default | Max/Team Premium → Opus 4.7; Pro/API → Sonnet 4.6 |
| `best` | `opus` | Most capable |
| `opus` | `claude-opus-4-7` | High reasoning |
| `sonnet` | `claude-sonnet-4-6` | Daily coding (recommended) |
| `haiku` | `claude-haiku-4-5` | Fast, simple tasks |
| `opusplan` | Opus (plan) + Sonnet (exec) | Plan phase uses Opus, execute uses Sonnet |
| `opus[1m]` | Opus 1M context | Long sessions |
| `sonnet[1m]` | Sonnet 1M context | Long sessions |

Full model IDs also accepted: `claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5`, etc.

### Effort levels

| Effort | Notes |
|---|---|
| `low` | Minimal reasoning |
| `medium` | Balanced |
| `high` | Deep reasoning |
| `xhigh` | Extra high (default for Opus 4.7) |
| `max` | Maximum budget |

Default effort by model:
- Opus 4.7: `xhigh`
- Opus 4.6, Sonnet 4.6: `high`

```bash
jonggrang plan "feature" --tool claude --model opus --effort xhigh
```

---

## OpenAI Codex CLI (`--tool codex`)

### Model IDs

| Model ID | Notes |
|---|---|
| `gpt-5-codex` | Default agentic coding model |
| `gpt-5.1-codex` | Codex snapshot |
| `gpt-5.3-codex-spark` | Real-time iteration, very fast |
| `gpt-5.2` | Latest, complex coding |
| `codex-mini-latest` | Smaller, lower cost |

### Effort levels

Passed as `--config reasoning_effort=<level>`.

| Effort | Notes |
|---|---|
| `low` | Fast, minimal reasoning; quick edits |
| `medium` | Balanced; general development |
| `high` | Deep reasoning; architecture, debugging |

```bash
jonggrang plan "feature" --tool codex --model gpt-5.1-codex --effort high
```

---

## OpenCode (`--tool opencode`)

Model IDs use `provider/model` format.

### Recommended models

| Provider | Model ID | Notes |
|---|---|---|
| `openai` | `openai/gpt-5.2` | Latest OpenAI |
| `opencode` | `opencode/gpt-5.1-codex` | OpenCode Zen |
| `anthropic` | `anthropic/claude-opus-4-7` | Opus 4.7 via OpenCode |
| `anthropic` | `anthropic/claude-sonnet-4-6` | Sonnet 4.6 via OpenCode |
| `google` | `google/gemini-2.5-pro` | Gemini Pro |
| `google` | `google/gemini-2.5-flash` | Gemini Flash |

Run `opencode models` for the full list (200+ entries).

### Effort levels (`--variant`)

Effort maps to `--variant` for OpenCode.

| Provider | Variant | Notes |
|---|---|---|
| OpenAI | `none` | No reasoning |
| OpenAI | `minimal` | Minimal effort |
| OpenAI | `low` | Low effort |
| OpenAI | `medium` | Medium effort |
| OpenAI | `high` | High effort |
| OpenAI | `xhigh` | Extra high effort |
| Anthropic | `high` | High thinking budget (default) |
| Anthropic | `max` | Maximum thinking budget |
| Google | `low` | Lower token budget |
| Google | `high` | Higher token budget |

```bash
jonggrang plan "feature" --tool opencode --model anthropic/claude-sonnet-4-6 --effort high
```

---

## Jonggrang / Pi SDK (`--tool jonggrang`)

Uses the Pi SDK directly (no CLI spawn). Model and effort are resolved internally.

### Model format

`provider/model-id` — Pi SDK supports 15+ providers.

| Provider | Example model IDs |
|---|---|
| `openai` | `openai/gpt-4o`, `openai/gpt-4.1`, `openai/gpt-5` |
| `anthropic` | `anthropic/claude-opus-4-7`, `anthropic/claude-sonnet-4-6` |
| `google` | `google/gemini-2.5-pro`, `google/gemini-2.5-flash` |
| `ollama` | `ollama/codellama`, `ollama/llama3.1` |

Run `jonggrang model` to browse the full interactive model registry.

### Effort

Effort is resolved per-model via the Pi SDK's internal `models.json` config.
No standardized `--effort` levels are publicly exposed — model selection implicitly determines reasoning depth.

```bash
jonggrang plan "feature" --tool jonggrang --model openai/gpt-4o
```

---

## jonggrang.json config

Persist defaults per project so you don't repeat flags every run:

```json
{
  "tool": "claude",
  "model": "sonnet",
  "effort": "high",
  "tools": {
    "claude": { "model": "opus", "effort": "xhigh" },
    "codex":  { "model": "gpt-5.1-codex", "effort": "high" }
  }
}
```

**5-level resolution order** (highest priority first):
1. CLI flag (`--model`, `--effort`)
2. `JONGGRANG_MODEL` / `JONGGRANG_EFFORT` env vars
3. `tools.<tool>.model` / `tools.<tool>.effort` in `jonggrang.json`
4. Top-level `model` / `effort` in `jonggrang.json`
5. Backend default
