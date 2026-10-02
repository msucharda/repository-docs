import assert from 'node:assert/strict';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const schemaUrl = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
export const skills = ['docs-create', 'docs-index', 'docs-update'];
export const agents = ['documentation-reviewer', 'repository-discovery'];
// Review runs on a different model family than discovery, both at xhigh effort.
export const agentModels = {
  'documentation-reviewer': 'claude-opus-5.5',
  'repository-discovery': 'gpt-6.1-sol',
};
export const procedures = [
  ...skills.map(name => `skills/${name}/SKILL.md`),
  ...agents.map(name => `com.github.copilot/agents/${name}.agent.md`),
];
const packageFiles = {
  references: ['documentation-policy.md', 'reuse-index.md', 'reuse-workflow.md'],
  templates: ['reuse-catalog.json', 'reuse-page.md'],
};

export function validateManifest(manifest) {
  assert.equal(manifest.$schema, schemaUrl, 'Use the canonical Agent Plugins 1.0 schema');
  const strings = ['name', 'version', 'description', 'homepage', 'repository', 'license'];
  const allowed = ['$schema', ...strings, 'author', 'keywords', 'extensions'];
  for (const key of Object.keys(manifest)) {
    assert.ok(allowed.includes(key), `Unsupported manifest field: ${key}`);
  }
  for (const key of strings) {
    if (key in manifest) assert.equal(typeof manifest[key], 'string', `${key} must be a string`);
  }
  assert.equal(typeof manifest.name, 'string');
  assert.ok(manifest.name.length <= 64 && /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(manifest.name),
    'Invalid plugin name');
  if ('author' in manifest) {
    assert.ok(manifest.author && typeof manifest.author === 'object' && !Array.isArray(manifest.author));
    for (const [key, value] of Object.entries(manifest.author)) {
      assert.ok(['name', 'email', 'url'].includes(key), `Unsupported author field: ${key}`);
      assert.equal(typeof value, 'string');
    }
  }
  if ('keywords' in manifest) {
    assert.ok(Array.isArray(manifest.keywords) && manifest.keywords.every(value => typeof value === 'string'));
  }
  if ('extensions' in manifest) {
    assert.ok(manifest.extensions && typeof manifest.extensions === 'object' && !Array.isArray(manifest.extensions));
    for (const value of Object.values(manifest.extensions)) {
      assert.ok(value && typeof value === 'object' && !Array.isArray(value));
    }
  }
}

// The repository is its own Copilot plugin marketplace with a single entry that
// installs the package root and mirrors the plugin manifest.
export function validateMarketplace(marketplace, manifest) {
  for (const key of Object.keys(marketplace)) {
    assert.ok(['name', 'owner', 'metadata', 'plugins'].includes(key), `Unsupported marketplace field: ${key}`);
  }
  assert.equal(marketplace.name, manifest.name, 'The marketplace is named after the plugin');
  assert.ok(marketplace.owner && typeof marketplace.owner.name === 'string' && marketplace.owner.name,
    'The marketplace needs an owner name');
  assert.ok(Array.isArray(marketplace.plugins) && marketplace.plugins.length === 1,
    'The marketplace lists exactly one plugin');
  const [entry] = marketplace.plugins;
  const mirrored = ['name', 'description', 'version', 'repository', 'license', 'keywords'];
  assert.deepEqual(Object.keys(entry).sort(), [...mirrored, 'source'].sort(), 'Unexpected marketplace entry fields');
  assert.equal(entry.source, './', 'The marketplace entry installs the repository root');
  for (const key of mirrored) {
    assert.deepEqual(entry[key], manifest[key], `Marketplace entry ${key} must match plugin.json`);
  }
}

// This package deliberately uses single-line JSON values, a small YAML subset.
export function frontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  assert.ok(match, 'Missing frontmatter');
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^([a-z-]+): (.+)$/.exec(line);
    assert.ok(field, `Unsupported frontmatter syntax: ${line}`);
    assert.ok(!(field[1] in fields), `Duplicate frontmatter field: ${field[1]}`);
    fields[field[1]] = JSON.parse(field[2]);
  }
  return fields;
}

export function validateProcedure(text, name, readOnlyAgent = false) {
  const fields = frontmatter(text);
  assert.deepEqual(Object.keys(fields).sort(), (readOnlyAgent
    ? ['name', 'description', 'tools', 'model', 'reasoning-effort']
    : ['name', 'description', 'compatibility']).sort());
  assert.equal(fields.name, name);
  assert.equal(typeof fields.description, 'string');
  assert.ok(fields.description.length > 0 && fields.description.length <= 1024);
  if (readOnlyAgent) {
    assert.deepEqual(fields.tools, ['read', 'search'], 'Read-only agents must have only documented read/search aliases');
    assert.equal(fields.model, agentModels[name], `${name} must run on ${agentModels[name]}`);
    assert.equal(fields['reasoning-effort'], 'xhigh', `${name} must use xhigh reasoning effort`);
  } else {
    assert.equal(typeof fields.compatibility, 'string');
    assert.ok(fields.compatibility.length > 0 && fields.compatibility.length <= 500);
    assert.ok(text.split('\n').length < 500);
  }
  const reference = '../../references/documentation-policy.md';
  assert.ok(localLinkTargets(text).includes(reference), `Required reference pointer is missing: ${reference}`);
}

export function resolveResource(root, sourceFile, target) {
  const resource = resolve(dirname(sourceFile), target);
  const pathWithinRoot = relative(realpathSync(root), realpathSync(resource));
  assert.ok(pathWithinRoot !== '..' && !pathWithinRoot.startsWith(`..${sep}`) && !isAbsolute(pathWithinRoot),
    `Resource escapes package: ${target}`);
  return resource;
}

export function localLinkTargets(text) {
  const prose = text.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[ \t\r]*$/gm, '')
    .replace(/(`+).*?\1/g, '');
  return [...prose.matchAll(/\[[^\]\n]*\]\(([^)\s]+)\)/g)]
    .map(match => match[1].split('#')[0])
    .filter(target => target && !/^[a-z][a-z0-9+.-]*:/i.test(target));
}

function markdownFiles(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name.startsWith('.stage1-test-')) continue;
    const path = join(root, entry.name);
    assert.ok(!lstatSync(path).isSymbolicLink(), `Unexpected symlink in package: ${path}`);
    if (entry.isDirectory()) files.push(...markdownFiles(path));
    else if (entry.name.endsWith('.md')) files.push(path);
  }
  return files;
}

export function validatePackage(root = packageRoot) {
  const manifest = JSON.parse(readFileSync(join(root, 'plugin.json'), 'utf8'));
  validateManifest(manifest);
  assert.equal(manifest.name, 'repository-docs');
  assert.equal(manifest.version, '1.0.1');
  assert.equal(manifest.license, 'MIT', 'The package is MIT licensed');
  validateMarketplace(JSON.parse(readFileSync(join(root, '.github', 'plugin', 'marketplace.json'), 'utf8')), manifest);
  assert.deepEqual(readdirSync(join(root, 'skills')).sort(), skills, 'Users see exactly three skills');
  assert.deepEqual(readdirSync(join(root, 'com.github.copilot', 'agents')).sort(),
    agents.map(name => `${name}.agent.md`));
  for (const [directory, names] of Object.entries(packageFiles)) {
    assert.deepEqual(readdirSync(join(root, directory)).sort(), names, `Unexpected files in ${directory}`);
  }
  assert.deepEqual(readdirSync(join(root, 'scripts')).filter(name => name !== 'export-public.mjs').sort(),
    ['reuse.mjs', 'validate-package.mjs'], 'Unexpected files in scripts');
  for (const path of [
    'mcp.json', '.mcp.json', 'hooks.json', 'agents',
    'com.github.copilot/hooks', 'com.github.copilot/rules',
    'com.github.copilot/commands', 'com.github.copilot/lsp.json',
  ]) {
    assert.ok(!existsSync(join(root, path)), `Out-of-scope runtime component: ${path}`);
  }
  for (const procedure of procedures) {
    const agent = procedure.endsWith('.agent.md');
    const name = agent ? procedure.split('/').at(-1).replace('.agent.md', '') : procedure.split('/').at(-2);
    validateProcedure(readFileSync(join(root, procedure), 'utf8'), name, agent);
  }
  for (const path of ['LICENSE', 'THIRD-PARTY-NOTICES.md']) {
    assert.ok(lstatSync(join(root, path)).isFile(), `Required file missing: ${path}`);
  }
  const catalog = JSON.parse(readFileSync(join(root, 'templates', 'reuse-catalog.json'), 'utf8'));
  assert.equal(catalog.formatVersion, 1, 'The catalog template must use format version 1');
  let links = 0;
  for (const file of markdownFiles(root)) {
    const text = readFileSync(file, 'utf8');
    for (const target of localLinkTargets(text)) {
      resolveResource(root, file, decodeURIComponent(target));
      links += 1;
    }
  }
  return { procedures: procedures.length, localFileLinks: links };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = validatePackage();
  console.log(`Package checks passed: ${result.procedures} procedures, ${result.localFileLinks} local file links.`);
  console.log('Static package profile only; not client loading, semantic review, or lifecycle certification.');
}
