# Jonggrang Skill System

Skills are **prompt templates in markdown format** that serve as complete, self-contained instructions for an AI coding agent. Each skill encodes expert knowledge for a specific task domain.

Jonggrang uses a **two-tier skill system**: a Core tier that is always loaded, and a Library tier that is loaded on demand via the Gateway.

---

## Two-Tier Architecture

```
skills/
├── core/                                    ← BIOS: always loaded into every agent prompt
│   ├── orchestrating-feature/SKILL.md
│   ├── iterating-to-completion/SKILL.md
│   ├── dispatching-parallel-agents/SKILL.md
│   ├── persisting-agent-outputs/SKILL.md
│   ├── persisting-progress-across-sessions/SKILL.md
│   ├── prd/SKILL.md
│   ├── scaffold-api/SKILL.md
│   ├── scaffold-webapp/SKILL.md
│   ├── scaffold-library/SKILL.md
│   ├── scaffold-cli/SKILL.md
│   ├── scaffold-tui/SKILL.md
│   ├── component/SKILL.md
│   ├── migration/SKILL.md
│   ├── auth/SKILL.md
│   ├── testing/SKILL.md
│   ├── deploy/SKILL.md
│   ├── gateway-backend/SKILL.md
│   ├── gateway-frontend/SKILL.md
│   ├── gateway-api/SKILL.md
│   ├── gateway-testing/SKILL.md
│   └── gateway-database/SKILL.md
│
└── library/                                 ← Hard Drive: JIT loaded via Gateway routing
    ├── backend/
    │   ├── developing-with-tdd/SKILL.md
    │   ├── debugging-systematically/SKILL.md
    │   └── error-handling-patterns/SKILL.md
    ├── frontend/
    │   ├── debugging-react-hooks/SKILL.md
    │   └── optimizing-react-performance/SKILL.md
    ├── testing/
    │   ├── unit-testing-patterns/SKILL.md
    │   └── fixing-flaky-tests/SKILL.md
    ├── database/
    │   └── safe-migrations/SKILL.md
    ├── api/
    │   └── input-validation/SKILL.md
    └── security/
        └── rate-limiting/SKILL.md
```

### Tier 1: Core (BIOS)

Core skills are **always included** in every agent's system prompt. They contain foundational patterns that every agent needs: how to invoke the gateway, how to orchestrate phases, how to dispatch parallel sub-agents, how to persist outputs.

Core skills are short and general-purpose. They do not bloat the prompt because they are always useful.

### Tier 2: Library (Hard Drive)

Library skills contain **deep domain knowledge** for specific scenarios. They are only loaded when the Gateway routes a task to that domain. A skill about "fixing flaky tests" would be wasteful to include in every prompt — it is only needed when the agent is actively debugging test reliability.

The Gateway resolves which library skills to load based on the task description. The agent receives only the skills it needs.

---

## The Gateway Pattern

The Gateway is the routing layer between agent intent and skill files. Instead of hardcoding skill names, agents describe their intent and the Gateway returns the right file paths.

### How It Works

```
1. Agent receives task: "Fix the SMTP timeout in email service"
2. Agent invokes Gateway: gateway.resolve("Fix SMTP timeout in email service")
3. Gateway detects domain: "backend" (matched via "timeout", "service")
4. Gateway returns:
   {
     domain: "backend",
     skill_paths: [
       "skills/library/backend/debugging-systematically/SKILL.md",
       "skills/library/backend/error-handling-patterns/SKILL.md"
     ],
     instruction: "Read these skills before implementing."
   }
5. Agent reads the returned skill files
6. Agent implements with full expert context
```

### Routing Table (keyword → domain)

| Keywords | Domain | Library Skills Loaded |
|----------|--------|-----------------------|
| route, controller, service, endpoint, middleware | backend | developing-with-tdd, debugging-systematically, error-handling-patterns |
| component, hook, render, state, UI | frontend | debugging-react-hooks, optimizing-react-performance |
| REST, GraphQL, OpenAPI, validation | api | input-validation |
| test, spec, coverage, mock, fixture | testing | unit-testing-patterns, fixing-flaky-tests |
| migration, query, schema, ORM | database | safe-migrations |
| rate-limit, auth, token, security | security | rate-limiting |

---

## Skill File Format

Every skill resides at `skills/<tier>/<domain>/<skill-name>/SKILL.md` (library) or `skills/core/<skill-name>/SKILL.md` (core):

```markdown
---
name: <skill-name>
description: One-line description
type: scaffold | transform | validate | generate
tier: core | library
domain: backend | frontend | api | testing | database | security
trigger: "natural language trigger phrase"
inputs:
  - name: <input-name>
    description: <what this input is>
    required: true|false
    default: <default value>
---

## Context
Background information. Use {{variable}} for interpolation.
Available variables: {{project_name}}, {{project_type}}, {{stack}},
{{test_framework}}, {{input.<name>}}

## Instructions
Numbered step-by-step instructions for the agent.

## Script (optional)
Inline bash scripts the agent executes directly.

## Validation
Checklist to verify successful execution.

## Examples (optional)
Input/output examples for reference.
```

---

## Skill Types

| Type | Purpose | Example |
|------|---------|---------|
| `scaffold` | Generate file structure + boilerplate | scaffold-api, component, migration |
| `transform` | Modify existing code | refactor, optimize |
| `validate` | Check/verify code | testing, security-scan |
| `generate` | Create documents/configs | prd, deploy, docs |

---

## Variable Interpolation

| Variable | Source | Example |
|----------|--------|---------|
| `{{project_name}}` | .jonggrang/jonggrang.json | my-awesome-app |
| `{{project_type}}` | .jonggrang/jonggrang.json | web-app |
| `{{stack}}` | .jonggrang/jonggrang.json | nextjs-typescript |
| `{{test_framework}}` | .jonggrang/jonggrang.json | vitest |
| `{{test_command}}` | .jonggrang/jonggrang.json | npm run test |
| `{{input.<name>}}` | User input at invocation | varies |

---

## Invoking Skills

### Via Gateway (automatic in orchestrate mode)

In orchestrate mode, the Developer and Tester agents invoke the Gateway automatically. The Gateway returns the right skill paths based on the current task description. No explicit skill name needed.

### Via CLI (work loop)

```bash
jonggrang work --skill prd
jonggrang work --skill component
jonggrang work --skill migration
```

### Via Task Reference

```json
{
  "id": "task-001",
  "title": "Create user registration endpoint",
  "skill": "scaffold-api",
  "skill_inputs": {
    "name": "users",
    "method": "POST",
    "path": "/api/users"
  }
}
```

### Auto-detection

Jonggrang auto-detects the relevant core skill from the task description:

| Task Description | Matched Skill |
|-----------------|---------------|
| "create endpoint" | scaffold-api |
| "create component" | component |
| "add migration" | migration |
| "setup auth" | auth |
| "write tests" | testing |
| "generate PRD" | prd |

---

## Core Skills Catalog

### Orchestration Skills

| Skill | Purpose |
|-------|---------|
| `orchestrating-feature` | Full 16-phase feature workflow orchestration |
| `iterating-to-completion` | Iteration loop with stuck detection |
| `dispatching-parallel-agents` | Spawn sub-agents for parallel work |
| `persisting-agent-outputs` | Save outputs to `.jonggrang/.output/` |

### Domain Gateways

| Skill | Routes To |
|-------|-----------|
| `gateway-backend` | backend/ library skills |
| `gateway-frontend` | frontend/ library skills |
| `gateway-api` | api/ library skills |
| `gateway-testing` | testing/ library skills |
| `gateway-database` | database/ library skills |

### Scaffold Skills

| Skill | Description |
|-------|-------------|
| `scaffold-api` | Route, controller, validation schema, tests |
| `scaffold-webapp` | Page component, layout, data fetching, tests |
| `scaffold-library` | src/, build config, exports, tests |
| `component` | UI component, test, story (if Storybook present) |
| `migration` | Migration file, model update, seed data |
| `auth` | Login, register, session/JWT, middleware, tests |

### Generate Skills

| Skill | Description |
|-------|-------------|
| `prd` | Product Requirements Document from intent |
| `testing` | Test suite for existing code |
| `deploy` | Dockerfile, CI/CD config, environment configs |

---

## Library Skills Catalog

### Backend

| Skill | What It Teaches |
|-------|----------------|
| `developing-with-tdd` | Red/Green/Refactor cycle, TypeScript examples |
| `debugging-systematically` | 6-step protocol: Reproduce → Isolate → Hypothesize → Verify → Fix → Confirm |
| `error-handling-patterns` | AppError class hierarchy, Express middleware, retry pattern |

### Frontend

| Skill | What It Teaches |
|-------|----------------|
| `debugging-react-hooks` | Infinite loop causes, stale closure, missing deps fixes |
| `optimizing-react-performance` | React.memo, useCallback, useMemo, virtualization |

### Testing

| Skill | What It Teaches |
|-------|----------------|
| `unit-testing-patterns` | AAA pattern, mocking strategies, test isolation |
| `fixing-flaky-tests` | Timing issues, test pollution, async leaks, order dependency |

### Database

| Skill | What It Teaches |
|-------|----------------|
| `safe-migrations` | Zero-downtime patterns, CONCURRENTLY indexes, rollback strategy |

### API

| Skill | What It Teaches |
|-------|----------------|
| `input-validation` | Zod schemas, Express middleware, security checklist |

### Security

| Skill | What It Teaches |
|-------|----------------|
| `rate-limiting` | express-rate-limit, Redis store, per-IP/per-user patterns |

---

## Creating Custom Skills

### Core Skill (general-purpose, loaded always)

```bash
mkdir -p skills/core/my-pattern
cat > skills/core/my-pattern/SKILL.md << 'EOF'
---
name: my-pattern
description: Describe what this teaches
type: scaffold
tier: core
---

## Context
...

## Instructions
1. ...
2. ...

## Validation
- [ ] ...
EOF
```

### Library Skill (domain-specific, JIT loaded)

```bash
mkdir -p skills/library/backend/my-deep-pattern
cat > skills/library/backend/my-deep-pattern/SKILL.md << 'EOF'
---
name: my-deep-pattern
description: Deep knowledge about X
type: transform
tier: library
domain: backend
trigger: "when working with X"
---

## Context
...

## Instructions
...

## Validation
...
EOF
```

After creating a library skill, add it to the relevant domain gateway so the routing table picks it up:

```markdown
<!-- In skills/core/gateway-backend.md -->
## Available Library Skills
...
- `backend/my-deep-pattern` — use when: working with X
```

---

## Skill Execution Flow

```
1. Agent receives task description
2. Agent calls Gateway with task description
3. Gateway scans ROUTING_TABLE for keyword matches
4. Gateway returns {domain, skill_paths, instruction}
5. Agent reads skill files from skill_paths
6. Agent interpolates {{variables}} from .jonggrang/jonggrang.json
7. Agent follows Instructions section (creates/modifies files)
8. Agent runs Script section if present
9. Agent verifies Validation checklist
10. If validation fails: retry or escalate per autonomy mode
```

### Resolution Order

When resolving a skill name, `resolveSkillPath` checks in order:

1. `skills/core/<name>/SKILL.md` — check core tier first
2. `skills/library/<domain>/<name>/SKILL.md` — check library tier
3. `skills/<name>/SKILL.md` — legacy flat structure (backward compat)
