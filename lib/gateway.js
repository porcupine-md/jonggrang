//
// JONGGRANG — Gateway Pattern
// Intent-based skill routing for two-tier skill architecture
//

const path = require('path');
const fs = require('fs');

// ============================================================
// DOMAIN DEFINITIONS
// ============================================================

const DOMAINS = {
  backend:  { label: 'Backend',  gateway_skill: 'gateway-backend' },
  frontend: { label: 'Frontend', gateway_skill: 'gateway-frontend' },
  api:      { label: 'API',      gateway_skill: 'gateway-api' },
  testing:  { label: 'Testing',  gateway_skill: 'gateway-testing' },
  database: { label: 'Database', gateway_skill: 'gateway-database' },
  // deploy and security have routing table entries but no gateway skills yet.
  // They route through library skills directly via routeToSkills().
};

// ============================================================
// INTENT ROUTING TABLE
// Library skills keyed by intent keywords → skill path
// ============================================================

// Only include skills that actually exist under skills/library/
const ROUTING_TABLE = {
  backend: [
    { keywords: ['tdd', 'test-driven', 'red-green'],           skill: 'backend/developing-with-tdd' },
    { keywords: ['debug', 'diagnose', 'trace', 'investigate'],  skill: 'backend/debugging-systematically' },
    { keywords: ['error handling', 'exception', 'retry'],        skill: 'backend/error-handling-patterns' },
    { keywords: ['rate limit', 'throttle', 'ddos'],              skill: 'security/rate-limiting' },
  ],
  frontend: [
    { keywords: ['infinite loop', 'useeffect', 'hook loop'],     skill: 'frontend/debugging-react-hooks' },
    { keywords: ['performance', 'render', 'memo', 'usememo'],    skill: 'frontend/optimizing-react-performance' },
  ],
  api: [
    { keywords: ['validation', 'sanitize', 'input'],              skill: 'api/input-validation' },
  ],
  testing: [
    { keywords: ['unit test', 'mock', 'stub', 'spy'],            skill: 'testing/unit-testing-patterns' },
    { keywords: ['flaky test', 'race condition', 'async test'],  skill: 'testing/fixing-flaky-tests' },
  ],
  database: [
    { keywords: ['migration', 'schema change', 'alter table'],   skill: 'database/safe-migrations' },
  ],
};

// ============================================================
// DOMAIN DETECTION
// ============================================================

const DOMAIN_KEYWORDS = {
  frontend: ['react', 'vue', 'angular', 'component', 'jsx', 'tsx', 'css', 'tailwind', 'next.js', 'nuxt', 'ui', 'ux', 'browser', 'dom', 'frontend', 'client-side'],
  database: ['sql', 'postgres', 'mysql', 'mongodb', 'redis', 'prisma', 'drizzle', 'typeorm', 'migration', 'query', 'schema', 'database', 'db'],
  testing:  ['test', 'spec', 'jest', 'vitest', 'pytest', 'coverage', 'mock', 'stub', 'fixture', 'e2e'],
  deploy:   ['docker', 'k8s', 'kubernetes', 'ci/cd', 'pipeline', 'deploy', 'infrastructure', 'devops'],
  security: ['auth', 'jwt', 'oauth', 'permission', 'role', 'acl', 'owasp', 'security', 'encrypt'],
  api:      ['rest', 'graphql', 'endpoint', 'route', 'openapi', 'swagger', 'webhook', 'api'],
  backend:  ['node', 'go', 'python', 'java', 'rust', 'server', 'backend', 'service', 'handler', 'controller'],
};

// Priority order for domain detection (more specific first)
const DOMAIN_PRIORITY = ['testing', 'database', 'deploy', 'security', 'frontend', 'api', 'backend'];

/**
 * Detect domain(s) from a text description.
 * Returns array of domain names, sorted by relevance.
 */
function detectDomains(text) {
  const lower = text.toLowerCase();
  const scores = {};

  for (const [domain, keywords] of Object.entries(DOMAIN_KEYWORDS)) {
    scores[domain] = keywords.filter(kw => lower.includes(kw)).length;
  }

  return DOMAIN_PRIORITY
    .filter(d => scores[d] > 0)
    .sort((a, b) => scores[b] - scores[a]);
}

/**
 * Find the primary domain for a task.
 */
function getPrimaryDomain(text) {
  const domains = detectDomains(text);
  return domains.length > 0 ? domains[0] : 'backend';
}

// ============================================================
// INTENT-BASED ROUTING
// ============================================================

/**
 * Route a task description to relevant library skill paths.
 * Returns array of skill paths relative to skills/library/.
 */
function routeToSkills(text, maxSkills = 3) {
  const lower = text.toLowerCase();
  const domains = detectDomains(text);
  const matched = [];

  for (const domain of domains) {
    const routes = ROUTING_TABLE[domain] || [];
    for (const route of routes) {
      const hits = route.keywords.filter(kw => lower.includes(kw)).length;
      if (hits > 0) {
        matched.push({ skill: route.skill, domain, hits });
      }
    }
  }

  return matched
    .sort((a, b) => b.hits - a.hits)
    .slice(0, maxSkills)
    .map(m => m.skill);
}

// ============================================================
// SKILL PATH RESOLUTION
// ============================================================

/**
 * Resolve a skill path to absolute file path.
 * Handles both core and library tier.
 */
function resolveSkillPath(skillRef, skillsBaseDir) {
  // Absolute path passed directly
  if (path.isAbsolute(skillRef)) {
    return fs.existsSync(skillRef) ? skillRef : null;
  }

  // Try core tier first
  const corePath = path.join(skillsBaseDir, 'core', skillRef, 'SKILL.md');
  if (fs.existsSync(corePath)) return corePath;

  // Try library tier
  const libPath = path.join(skillsBaseDir, 'library', skillRef, 'SKILL.md');
  if (fs.existsSync(libPath)) return libPath;

  // Try legacy flat structure (backward compat)
  const legacyPath = path.join(skillsBaseDir, skillRef, 'SKILL.md');
  if (fs.existsSync(legacyPath)) return legacyPath;

  return null;
}

/**
 * Get gateway skill path for a domain.
 */
function getGatewaySkillPath(domain, skillsBaseDir) {
  const domainConfig = DOMAINS[domain];
  if (!domainConfig) return null;
  return resolveSkillPath(domainConfig.gateway_skill, skillsBaseDir);
}

/**
 * List all available core skills.
 */
function listCoreSkills(skillsBaseDir) {
  const coreDir = path.join(skillsBaseDir, 'core');
  if (!fs.existsSync(coreDir)) return [];
  return fs.readdirSync(coreDir)
    .filter(name => fs.existsSync(path.join(coreDir, name, 'SKILL.md')))
    .map(name => ({ name, tier: 'core', path: path.join(coreDir, name, 'SKILL.md') }));
}

/**
 * List all available library skills.
 */
function listLibrarySkills(skillsBaseDir) {
  const libDir = path.join(skillsBaseDir, 'library');
  if (!fs.existsSync(libDir)) return [];

  const skills = [];
  const domains = fs.readdirSync(libDir).filter(d =>
    fs.statSync(path.join(libDir, d)).isDirectory()
  );

  for (const domain of domains) {
    const domainDir = path.join(libDir, domain);
    const skillDirs = fs.readdirSync(domainDir).filter(d =>
      fs.existsSync(path.join(domainDir, d, 'SKILL.md'))
    );
    for (const skillName of skillDirs) {
      skills.push({
        name: `${domain}/${skillName}`,
        domain,
        tier: 'library',
        path: path.join(domainDir, skillName, 'SKILL.md'),
      });
    }
  }

  return skills;
}

/**
 * Build a gateway response — the list of skill paths the agent should load.
 * This is what a gateway skill returns at runtime.
 */
function buildGatewayResponse(taskDescription, skillsBaseDir) {
  const skillRefs = routeToSkills(taskDescription);
  const resolved = skillRefs
    .map(ref => resolveSkillPath(ref, skillsBaseDir))
    .filter(Boolean);

  const domain = getPrimaryDomain(taskDescription);
  const gatewayPath = getGatewaySkillPath(domain, skillsBaseDir);

  return {
    domain,
    detected_skills: skillRefs,
    skill_paths: resolved,
    gateway_skill: gatewayPath,
    instruction: resolved.length > 0
      ? `Load these skill files before proceeding:\n${resolved.map(p => `  - ${p}`).join('\n')}`
      : `No specific library skills matched. Proceed with core skills only.`,
  };
}

module.exports = {
  DOMAINS,
  ROUTING_TABLE,
  DOMAIN_KEYWORDS,
  detectDomains,
  getPrimaryDomain,
  routeToSkills,
  resolveSkillPath,
  getGatewaySkillPath,
  listCoreSkills,
  listLibrarySkills,
  buildGatewayResponse,
};
