# Jonggrang Skill System

Skills are **prompt templates in markdown format** that serve as complete instructions for Claude Code. Each skill contains context, step-by-step instructions, optional scripts, and a validation checklist.

---

## Skill File Format

Each skill resides in `skills/<skill-name>/SKILL.md`:

```markdown
---
name: <skill-name>
description: One-line description
type: scaffold | transform | validate | generate
project_types: [web-app, api, library]
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
Numbered step-by-step instructions for Claude Code.

## Script (optional)
Inline bash scripts. Claude Code executes these directly.

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

Skills can use variables from `jonggrang.json` and user inputs:

| Variable | Source | Example |
|----------|--------|---------|
| `{{project_name}}` | jonggrang.json | my-awesome-app |
| `{{project_type}}` | jonggrang.json | web-app |
| `{{stack}}` | jonggrang.json | nextjs-typescript |
| `{{test_framework}}` | jonggrang.json | vitest |
| `{{test_command}}` | jonggrang.json | npm run test |
| `{{input.<name>}}` | User input at invocation time | varies |

---

## Invoking Skills

### Via jonggrang work
```bash
$ jonggrang work --skill prd
$ jonggrang work --skill component
$ jonggrang work --skill migration
```

### Via task reference
In `jonggrang-tasks.json`, a task can reference a skill:
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
Jonggrang can auto-detect the relevant skill based on the task description:
- "create endpoint" --> scaffold-api
- "create component" --> component
- "add migration" --> migration
- "setup auth" --> auth

---

## Creating Custom Skills

```bash
$ jonggrang skill add my-custom-skill
# Creates skills/my-custom-skill/SKILL.md with template
```

Generated template:

```markdown
---
name: my-custom-skill
description: TODO - describe this skill
type: scaffold
project_types: [web-app, api, library]
trigger: "TODO - natural language trigger"
inputs:
  - name: name
    description: Name of the thing to create
    required: true
---

## Context
TODO - describe the context

## Instructions
1. TODO - step 1
2. TODO - step 2

## Validation
- [ ] TODO - validation check
```

---

## Built-in Skills Catalog

### 1. prd (generate)
Generate a Product Requirements Document from an intent/description.

### 2. scaffold-api (scaffold)
Set up an API endpoint: route, controller, validation, tests.

### 3. scaffold-webapp (scaffold)
Set up web app pages: page component, layout, data fetching, tests.

### 4. scaffold-library (scaffold)
Set up library structure: src, build config, exports, tests.

### 5. component (scaffold)
Generate a UI component: component file, test, story (if Storybook).

### 6. migration (scaffold)
Generate a database migration: migration file, model update, seed data.

### 7. auth (scaffold)
Set up authentication: login, register, session/JWT, middleware, tests.

### 8. testing (generate)
Generate a test suite for existing code: unit tests, integration tests.

### 9. deploy (generate)
Set up deployment: Dockerfile, CI/CD config, environment configs.

---

## Skill Execution Flow

```
1. User invokes skill (via CLI or task reference)
2. Jonggrang reads SKILL.md
3. Interpolate variables (from jonggrang.json + inputs)
4. Feed complete prompt to Claude Code
5. Claude Code executes:
   a. Follow Instructions (create/modify files)
   b. Run Scripts (if any)
   c. Run Validation checks
6. Report results
7. If validation fails: retry or escalate based on autonomy mode
```
