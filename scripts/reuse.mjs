#!/usr/bin/env node
// Organization reuse index helper: connect to or create an index, clone repositories on demand,
// publish a repository's committed reuse catalog and regenerate the routing files.
// The index is routing only; each repository's docs/reuse pages stay canonical.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export const INDEX_MAX_BYTES = 16 * 1024;
const CATALOG = 'docs/reuse/catalog.json';
const DEFAULT_PURPOSE = 'Find shared libraries and integrations before implementing new ones.';
const helper = fileURLToPath(import.meta.url);
const types = new Set(['library', 'integration']);
const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0' };

const gitRaw = (checkout, ...args) => execFileSync('git', ['-C', checkout, ...args], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv,
});
const git = (checkout, ...args) => gitRaw(checkout, ...args).trim();
const tryGit = (checkout, ...args) => spawnSync('git', ['-C', checkout, ...args], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv,
});
const compare = (left, right) => left.localeCompare(right, 'en');
const json = value => `${JSON.stringify(value, null, 2)}\n`;

export const oneLine = (value, name) => {
  assert(typeof value === 'string' && value.trim() && !/[\r\n]/.test(value), `${name} must be one nonempty line`);
  return value.trim();
};

function knownFields(value, allowed, name) {
  assert(value && typeof value === 'object' && !Array.isArray(value), `${name} must be an object`);
  for (const key of Object.keys(value)) {
    assert(allowed.includes(key), `${name}: unknown field ${key}`);
  }
}

function validName(name) {
  return typeof name === 'string'
    && /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(name)
    && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name);
}
const validAreaId = id => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id);

export function parseCatalog(catalog, { link, revision, pageExists }) {
  assert(!/[\s()<>]/.test(link), `Unsafe link base: ${link}`);
  assert(catalog && typeof catalog === 'object' && !Array.isArray(catalog), 'catalog must be an object');
  assert.equal(catalog.formatVersion, 1, 'Unsupported catalog format');
  const repository = oneLine(catalog.repository, 'repository');
  assert(Array.isArray(catalog.units) && catalog.units.length, `${repository} has no units`);
  const units = catalog.units.map(unit => {
    const id = oneLine(unit.id, 'id');
    assert(id.startsWith(`${repository}:`), `${id} does not belong to ${repository}`);
    assert(types.has(unit.type), `${id}: unknown type ${unit.type}`);
    assert(typeof unit.page === 'string' && /^docs\/reuse\/[A-Za-z0-9._/-]+\.md$/.test(unit.page)
      && !unit.page.split('/').includes('..'), `${id}: unsafe page path`);
    assert(pageExists(unit.page), `${id}: page ${unit.page} is missing`);
    assert(unit.package === null || typeof unit.package === 'string', `${id}: package must be a string or null`);
    assert(Array.isArray(unit.keywords) && unit.keywords.every(item => typeof item === 'string'), `${id}: keywords`);
    return { id, type: unit.type, page: unit.page, summary: oneLine(unit.summary, `${id} summary`),
      status: oneLine(unit.status, `${id} status`), version: oneLine(unit.version, `${id} version`),
      package: unit.package, keywords: unit.keywords, area: unit.area };
  });
  return { repository, link, revision, units };
}

export function renderUnitLine(entry) {
  const release = entry.package ? `Package ${entry.package} ${entry.version}` : `Version ${entry.version}`;
  const keywords = entry.keywords.length ? `; keywords ${entry.keywords.join(', ')}` : '';
  return `- [${entry.id}](${entry.catalog.link}${entry.page}): ${entry.summary} ${release}; status ${entry.status}`
    + `${keywords}; source ${entry.catalog.repository} at ${entry.catalog.revision.slice(0, 12)}.`;
}

function validateManifest(manifest) {
  knownFields(manifest, ['title', 'purpose', 'repositories'], 'manifest');
  oneLine(manifest.title, 'manifest title');
  oneLine(manifest.purpose, 'manifest purpose');
  assert(Array.isArray(manifest.repositories), 'manifest repositories must be a list');
  const names = new Set();
  for (const [i, repository] of manifest.repositories.entries()) {
    knownFields(repository, ['name', 'url', 'branch', 'owner', 'area'],
      `manifest repository ${repository?.name ?? i}`);
    assert(validName(repository.name),
      `manifest repository ${repository.name ?? i}: invalid name`);
    const nameKey = repository.name.toLowerCase();
    assert(!names.has(nameKey), `Duplicate manifest repository name ${repository.name}`);
    names.add(nameKey);
    for (const field of ['url', 'branch', 'owner']) {
      oneLine(repository[field], `manifest repository ${repository.name} ${field}`);
    }
    assert(typeof repository.area === 'string' && repository.area.trim(),
      `manifest repository ${repository.name ?? i}: missing area`);
  }
  return manifest;
}

const readManifest = index => validateManifest(JSON.parse(readFileSync(join(index, 'manifest.json'), 'utf8')));

function validateAreas(taxonomy) {
  knownFields(taxonomy, ['areas'], 'areas');
  assert(Array.isArray(taxonomy.areas), 'areas must contain an areas list');
  const ids = new Set();
  for (const [i, area] of taxonomy.areas.entries()) {
    knownFields(area, ['id', 'title', 'description'], `area ${area?.id ?? i}`);
    assert(validAreaId(area.id), `area ${area.id}: invalid id`);
    const key = area.id.toLowerCase();
    assert(!ids.has(key), `Duplicate area ${area.id}`);
    ids.add(key);
    oneLine(area.title, `area ${area.id} title`);
    oneLine(area.description, `area ${area.id} description`);
  }
  return taxonomy;
}

const readAreas = index => validateAreas(JSON.parse(readFileSync(join(index, 'areas.json'), 'utf8')));

function originIdentity(value) {
  const scp = /^(?:(?<user>[^@/:]+)@)?(?<host>[^/:]+):(?<path>[^/?#][^?#]*)$/.exec(value);
  let host;
  let path;
  let user;
  if (scp) {
    ({ host, path, user } = scp.groups);
  } else {
    let url;
    try {
      url = new URL(value);
    } catch {
      return value;
    }
    if (!['https:', 'ssh:'].includes(url.protocol) || url.port || url.search || url.hash) return value;
    host = url.hostname;
    path = url.pathname.replace(/^\/+/, '');
    user = url.username;
    if (url.protocol === 'ssh:' && !user) return value;
  }
  const parts = path.replace(/\/+$/, '').split('/');
  const repository = parts.at(-1)?.replace(/\.git$/i, '');
  if (!repository) return value;
  parts[parts.length - 1] = repository;
  const domain = host.toLowerCase();
  // GitHub and Azure DevOps treat owner, project and repository names case-insensitively.
  const lower = parts.map(part => part.toLowerCase());
  if (domain === 'github.com' && parts.length === 2
    && (!scp || user === 'git')) {
    return `github:${lower.join('/')}`;
  }
  if (domain === 'dev.azure.com' && parts.length === 4 && parts[2] === '_git'
    && !scp) {
    return `azure:${lower[0]}/${lower[1]}/${lower[3]}`;
  }
  if ((domain === 'ssh.dev.azure.com' || domain === 'vs-ssh.visualstudio.com')
    && parts.length === 4 && parts[0] === 'v3'
    && (user === 'git' || user?.toLowerCase() === lower[1])) {
    return `azure:${lower[1]}/${lower[2]}/${lower[3]}`;
  }
  const legacy = /^([^.]+)\.visualstudio\.com$/.exec(domain);
  if (legacy && !scp && (parts.length === 3 || (parts.length === 4 && parts[0] === 'DefaultCollection'))
    && parts[parts.length - 2] === '_git') {
    return `azure:${legacy[1]}/${lower[parts.length - 3]}/${lower[parts.length - 1]}`;
  }
  return value;
}

export const sameOrigin = (expected, actual) => originIdentity(expected) === originIdentity(actual);

export function repositoryName(url) {
  const name = url.replace(/[?#].*$/, '').replace(/[\\/]+$/, '').split(/[\\/:]/).at(-1)?.replace(/\.git$/i, '');
  assert(validName(name), `${url}: cannot derive a repository name; pass --name`);
  return name;
}

function samePath(left, right) {
  const normalize = path => (process.platform === 'win32' ? path.toLowerCase() : path);
  return normalize(realpathSync.native(left)) === normalize(realpathSync.native(right));
}

function inspectClone(checkout, url) {
  const entry = lstatSync(checkout, { throwIfNoEntry: false });
  if (!entry) return { state: 'missing' };
  assert(entry.isDirectory(), `${checkout}: existing clone must be a directory, not a link`);
  assert(samePath(git(checkout, 'rev-parse', '--show-toplevel'), checkout),
    `${checkout}: existing directory is not a Git checkout root`);
  const origin = tryGit(checkout, 'remote', 'get-url', 'origin');
  const actual = origin.status === 0 ? origin.stdout.trim() : '(none)';
  return { state: sameOrigin(url, actual) ? 'matching' : 'foreign origin', origin: actual };
}

function aheadBehind(checkout, tracking) {
  return git(checkout, 'rev-list', '--left-right', '--count', `HEAD...${tracking}`).split(/\s+/).map(Number);
}

function localState(checkout, branch) {
  const current = git(checkout, 'branch', '--show-current');
  if (current !== branch) return `on ${current || 'detached HEAD'}, not ${branch}`;
  if (git(checkout, 'status', '--porcelain=v1', '--untracked-files=all')) return 'has local changes';
  const tracking = `refs/remotes/origin/${branch}`;
  if (!tryGit(checkout, 'rev-parse', '--verify', '--quiet', tracking).stdout.trim()) return 'clean';
  const [ahead, behind] = aheadBehind(checkout, tracking);
  if (ahead) return 'diverged';
  return behind ? 'behind (local refs)' : 'clean';
}

function fetchBranch(checkout, branch) {
  git(checkout, 'fetch', '--no-tags', '--no-write-fetch-head', 'origin',
    `+refs/heads/${branch}:refs/remotes/origin/${branch}`);
  return `refs/remotes/origin/${branch}`;
}

function cloneRepository(checkout, url, branch) {
  mkdirSync(dirname(checkout), { recursive: true });
  execFileSync('git', ['clone', '--quiet', ...(branch ? ['--branch', branch] : []), '--', url, checkout],
    { stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv });
}

function remoteIsEmpty(url) {
  const result = spawnSync('git', ['ls-remote', '--', url], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv });
  assert(result.status === 0, `Cannot reach ${url}: ${result.stderr.trim()}`);
  return !result.stdout.trim();
}

// Online lookups (index writes, new registrations) must get the answer from the remote,
// so a renamed default branch is never replaced by a stale local origin/HEAD.
function remoteDefaultBranch(checkout, { online = false } = {}) {
  const fromRemote = () => {
    const remote = tryGit(checkout, 'ls-remote', '--symref', 'origin', 'HEAD');
    return remote.status === 0 ? /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(remote.stdout)?.[1] : undefined;
  };
  if (online) {
    const branch = fromRemote();
    assert(branch, `${checkout}: cannot ask origin for its default branch; check the network and access`);
    return branch;
  }
  const local = tryGit(checkout, 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD');
  if (local.status === 0 && local.stdout.trim()) return local.stdout.trim().replace(/^origin\//, '');
  const branch = fromRemote();
  assert(branch, `${checkout}: cannot determine the default branch of origin`);
  return branch;
}

// Configuration and the personal pointer.

const configPath = home => join(home, '.org-reuse', 'config.json');
const pointerPath = home => join(home, '.copilot', 'instructions', 'org-reuse.instructions.md');

export const instructionFor = (root, indexRepo, script = helper) =>
  `---\napplyTo: "**"\n---\nBefore implementing an integration, API client, data extractor or shared utility, `
  + `run \`node "${script}" ensure\` to refresh the organization's reuse index, then read `
  + `\`${join(root, indexRepo, 'llms.txt')}\` and use the libraries and integrations it links. `
  + 'Repositories are cloned on demand: before opening a link into another repository (`../<name>/...`), '
  + `run \`node "${script}" ensure <name>\`; it clones that repository when missing or fast-forwards a clean clone.\n`;

function readConfig() {
  const home = homedir();
  const path = configPath(home);
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (!entry) return null;
  assert(entry.isFile(), `${path}: configuration must be a regular file`);
  const settings = JSON.parse(readFileSync(path, 'utf8'));
  knownFields(settings, ['root', 'indexRepo', 'indexUrl'], 'configuration');
  assert(typeof settings.root === 'string' && isAbsolute(settings.root), `${path}: root must be an absolute path`);
  assert(validName(settings.indexRepo), `${path}: invalid index repository name`);
  if (settings.indexUrl !== null) oneLine(settings.indexUrl, 'index repository URL');
  return { ...settings, home, index: join(settings.root, settings.indexRepo) };
}

function requireConfig() {
  const config = readConfig();
  assert(config, `${configPath(homedir())}: no organization index is configured; run /docs-index first`);
  return config;
}

function checkPersonalPaths(home) {
  for (const directory of [dirname(configPath(home)), join(home, '.copilot'), dirname(pointerPath(home))]) {
    const entry = lstatSync(directory, { throwIfNoEntry: false });
    assert(!entry || entry.isDirectory(), `${directory}: configuration directory must not be a link or file`);
  }
  for (const file of [configPath(home), pointerPath(home)]) {
    const entry = lstatSync(file, { throwIfNoEntry: false });
    assert(!entry || entry.isFile(), `${file}: must be a regular file`);
  }
}

async function confirmPointer(home, instruction) {
  const pointer = pointerPath(home);
  if (!existsSync(pointer)) return;
  const previous = readFileSync(pointer, 'utf8');
  if (previous === instruction) return;
  console.error(`--- existing ${pointer}\n${previous.trimEnd().split('\n').map(line => `- ${line}`).join('\n')}`
    + `\n+++ proposed ${pointer}\n${instruction.trimEnd().split('\n').map(line => `+ ${line}`).join('\n')}`);
  process.stderr.write('Type yes to replace the personal instruction: ');
  const reader = createInterface({ input: process.stdin });
  const answer = await new Promise(resolveAnswer => {
    reader.once('line', resolveAnswer);
    reader.once('close', () => resolveAnswer(''));
  });
  reader.close();
  assert(answer.trim() === 'yes', `${pointer}: existing pointer not replaced`);
}

function writePersonalFiles(home, settings, instruction) {
  mkdirSync(dirname(configPath(home)), { recursive: true });
  mkdirSync(dirname(pointerPath(home)), { recursive: true });
  writeFileSync(configPath(home), json(settings));
  writeFileSync(pointerPath(home), instruction);
  console.log(`Wrote ${configPath(home)}\nWrote ${pointerPath(home)}`);
}

// Index checkout state.

function indexBranch(config, { online = false } = {}) {
  const { index, indexUrl } = config;
  assert(lstatSync(index, { throwIfNoEntry: false })?.isDirectory(),
    `${index}: index clone is missing; run /docs-index to connect again`);
  assert(samePath(git(index, 'rev-parse', '--show-toplevel'), index), `${index}: not a Git checkout root`);
  const current = git(index, 'branch', '--show-current');
  if (!indexUrl) {
    assert(current, `${index}: index is on a detached HEAD`);
    return current;
  }
  const origin = inspectClone(index, indexUrl);
  assert(origin.state === 'matching', `${index}: foreign origin; expected ${indexUrl}, actual ${origin.origin}`);
  const expected = remoteDefaultBranch(index, { online });
  assert(current === expected, `${index}: expected branch ${expected}, found ${current || 'detached HEAD'}`);
  return current;
}

function refreshIndex(config, { strict }) {
  const branch = indexBranch(config, { online: strict });
  const { index } = config;
  const fail = message => {
    if (strict) throw new Error(message);
    console.log(`index: ${message}; using the local copy`);
    return branch;
  };
  if (git(index, 'status', '--porcelain=v1', '--untracked-files=all')) {
    return fail(`${index} has local changes`);
  }
  if (!config.indexUrl) return branch;
  let tracking;
  try {
    tracking = fetchBranch(index, branch);
  } catch (error) {
    return fail(`could not fetch ${config.indexUrl} (${error.stderr?.trim() || error.message})`);
  }
  const [ahead, behind] = aheadBehind(index, tracking);
  if (ahead) return fail(`${index} has commits that are not on origin/${branch}`);
  if (behind) {
    git(index, 'merge', '--ff-only', '--quiet', tracking);
    console.log('index: fast-forwarded');
  }
  return branch;
}

function committedRecord(index) {
  if (!tryGit(index, 'rev-parse', '--verify', '--quiet', 'HEAD').stdout.trim()) return {};
  if (!git(index, 'ls-tree', '--name-only', 'HEAD', '--', 'catalog-revisions.json')) return {};
  return validateRecord(JSON.parse(git(index, 'show', 'HEAD:catalog-revisions.json')), index).repositories;
}

function validateRecord(record, index) {
  knownFields(record, ['formatVersion', 'repositories', 'generatedAreas'], 'catalog revisions');
  assert(record.formatVersion === 1, `${index}: unsupported catalog revision format`);
  assert(record.repositories && typeof record.repositories === 'object'
    && !Array.isArray(record.repositories), `${index}: invalid catalog revision repositories`);
  for (const [name, revision] of Object.entries(record.repositories)) {
    assert(validName(name) && typeof revision === 'string' && /^[0-9a-f]{40}$/.test(revision),
      `${index}: invalid catalog revision for ${name}`);
  }
  assert(Array.isArray(record.generatedAreas) && record.generatedAreas.every(validAreaId),
    `${index}: invalid generated areas in catalog revisions`);
  return record;
}

// Generation from published catalog snapshots.

function siblingCatalog(index, repository) {
  const checkout = join(dirname(index), repository.name);
  assert(existsSync(checkout),
    `${repository.name}: no published catalog in catalogs/ and no clone at ${checkout}; publish it from its repository`);
  const clone = inspectClone(checkout, repository.url);
  assert(clone.state === 'matching',
    `${repository.name}: clone at ${checkout} has origin ${clone.origin}, not ${repository.url}`);
  const branch = git(checkout, 'branch', '--show-current');
  assert(branch === repository.branch,
    `${repository.name}: expected branch ${repository.branch}, found ${branch || 'detached HEAD'}`);
  assert(!git(checkout, 'status', '--porcelain=v1', '--untracked-files=all', '--', CATALOG),
    `${repository.name}: catalog has uncommitted changes`);
  const revision = git(checkout, 'log', '-1', '--format=%H', '--', CATALOG);
  assert(revision, `${repository.name}: catalog has no committed revision`);
  const tracking = `refs/remotes/origin/${repository.branch}`;
  if (tryGit(checkout, 'rev-parse', '--verify', '--quiet', tracking).stdout.trim()) {
    assert(!aheadBehind(checkout, tracking)[0],
      `${repository.name}: ${checkout} has commits that are not on origin/${repository.branch}; push them first`);
  }
  return {
    text: gitRaw(checkout, 'show', `HEAD:${CATALOG}`), revision,
    pageExists: page => tryGit(checkout, 'cat-file', '-t', `HEAD:${page}`).stdout.trim() === 'blob',
  };
}

function regularOutput(index, file) {
  const entry = lstatSync(join(index, file), { throwIfNoEntry: false });
  assert(!entry || entry.isFile(), `${file}: generated output must be a regular file`);
}

// Without a supplied manifest (the generate command), sibling clones on their manifest branch
// take precedence over published snapshots; publish and create use snapshots first.
export function generate(index, { manifest, taxonomy, publication } = {}) {
  assert(lstatSync(index).isDirectory(), `${index}: index checkout must be a directory`);
  const writeInputs = manifest !== undefined;
  manifest = validateManifest(manifest ?? readManifest(index));
  taxonomy = validateAreas(taxonomy ?? readAreas(index));
  const title = oneLine(manifest.title, 'manifest title');
  const purpose = oneLine(manifest.purpose, 'manifest purpose');
  const areas = new Map(taxonomy.areas.map(area => [area.id, { ...area, entries: [] }]));
  for (const repository of manifest.repositories) {
    assert(areas.has(repository.area),
      `manifest repository ${repository.name}: unknown area ${repository.area}`);
  }
  const recordPath = join(index, 'catalog-revisions.json');
  regularOutput(index, 'catalog-revisions.json');
  const previous = existsSync(recordPath) ? validateRecord(JSON.parse(readFileSync(recordPath, 'utf8')), index) : null;
  const snapshotDir = join(index, 'catalogs');
  const snapshotEntry = lstatSync(snapshotDir, { throwIfNoEntry: false });
  assert(!snapshotEntry || snapshotEntry.isDirectory(), 'catalogs: must be a directory, not a link or file');
  const catalogNames = new Set();
  const snapshots = new Map();
  const catalogs = manifest.repositories.map(repository => {
    const file = `catalogs/${repository.name}.json`;
    regularOutput(index, file);
    let source;
    if (publication?.name === repository.name) {
      source = publication;
    } else if (!writeInputs && existsSync(join(dirname(index), repository.name))) {
      source = siblingCatalog(index, repository);
    } else if (existsSync(join(index, file))) {
      const revision = previous?.repositories[repository.name];
      assert(revision, `${repository.name}: ${file} has no recorded revision in catalog-revisions.json`);
      source = { text: readFileSync(join(index, file), 'utf8'), revision, pageExists: () => true };
    } else {
      source = siblingCatalog(index, repository);
    }
    let parsed;
    try {
      parsed = JSON.parse(source.text);
    } catch (error) {
      throw new Error(`${repository.name}: invalid catalog JSON (${error.message})`);
    }
    const catalog = parseCatalog(parsed, { link: `../${repository.name}/`, revision: source.revision,
      pageExists: source.pageExists });
    assert(!catalogNames.has(catalog.repository), `Duplicate catalog repository ${catalog.repository}`);
    catalogNames.add(catalog.repository);
    for (const unit of catalog.units) {
      const area = unit.area === undefined ? repository.area : unit.area;
      assert(areas.has(area), `${unit.id}: unknown area ${area}`);
      areas.get(area).entries.push({ ...unit, catalog });
    }
    snapshots.set(file, source.text);
    return { ...catalog, name: repository.name };
  });
  const generatedAreas = [];
  const outputs = new Map();
  const rootLines = [
    `# ${title}`, '', `> ${purpose}`, '',
    'Reusable libraries and existing integrations. Open the linked canonical reuse page before implementing.',
    'Links to `../<repository>/` resolve to sibling clones of this index, cloned on demand; '
      + '`manifest.json` lists each repository\'s URL and branch.',
    '', '## Areas', '',
  ];
  for (const area of [...areas.values()].sort((a, b) => compare(a.id, b.id))) {
    if (!area.entries.length) {
      console.error(`Warning: area ${area.id} has no units`);
      continue;
    }
    generatedAreas.push(area.id);
    const file = `area-${area.id}.txt`;
    rootLines.push(`- [${area.title}](${file}): ${area.description}`);
    outputs.set(file, `# ${area.title}\n\n> ${area.description}\n\n`
      + area.entries.sort((a, b) => compare(a.id, b.id)).map(renderUnitLine).join('\n') + '\n');
  }
  if (!generatedAreas.length) rootLines.push('No repositories are published yet.');
  rootLines.push('', 'If no area fits, grep the published catalogs in this index\'s `catalogs/` folder for the task.',
    '', '## Catalogs', '');
  for (const catalog of [...catalogs].sort((a, b) => compare(a.name, b.name))) {
    rootLines.push(`- [${catalog.repository}](catalogs/${catalog.name}.json): `
      + `Published catalog of ${catalog.repository} at ${catalog.revision.slice(0, 12)}.`);
  }
  outputs.set('llms.txt', `${rootLines.join('\n')}\n`);
  outputs.set('catalog-revisions.json', json({
    formatVersion: 1,
    repositories: Object.fromEntries([...catalogs].sort((a, b) => compare(a.name, b.name))
      .map(catalog => [catalog.name, catalog.revision])),
    generatedAreas,
  }));
  for (const [file, content] of outputs) {
    const bytes = Buffer.byteLength(content, 'utf8');
    assert(bytes <= INDEX_MAX_BYTES, `${file} is ${bytes} bytes; exceeds the ${INDEX_MAX_BYTES}-byte index budget`);
    regularOutput(index, file);
  }
  const touched = [...outputs.keys(), ...snapshots.keys()];
  if (writeInputs) {
    for (const file of ['manifest.json', 'areas.json']) regularOutput(index, file);
    writeFileSync(join(index, 'manifest.json'), json(manifest));
    writeFileSync(join(index, 'areas.json'), json(taxonomy));
    touched.push('manifest.json', 'areas.json');
  }
  for (const [file, content] of outputs) writeFileSync(join(index, file), content);
  if (snapshots.size) mkdirSync(snapshotDir, { recursive: true });
  for (const [file, content] of snapshots) writeFileSync(join(index, file), content);
  for (const id of previous?.generatedAreas ?? []) {
    const file = `area-${id}.txt`;
    if (!outputs.has(file) && lstatSync(join(index, file), { throwIfNoEntry: false })) {
      unlinkSync(join(index, file));
      touched.push(file);
    }
  }
  if (snapshotEntry) {
    for (const name of readdirSync(snapshotDir)) {
      if (name.endsWith('.json') && !snapshots.has(`catalogs/${name}`)) {
        unlinkSync(join(snapshotDir, name));
        touched.push(`catalogs/${name}`);
      }
    }
  }
  console.log(`Wrote ${outputs.size} files in ${index}`);
  return { catalogs, generatedAreas, touched };
}

// Commands.

function status(checkout) {
  const config = readConfig();
  if (!config) {
    console.log(`Index: not configured (${configPath(homedir())} is missing)`);
    return;
  }
  const { index, root, indexRepo, indexUrl, home } = config;
  console.log(`Index: ${index} (${indexUrl ?? 'local only, no remote'})`);
  const pointer = pointerPath(home);
  const entry = lstatSync(pointer, { throwIfNoEntry: false });
  assert(!entry || entry.isFile(), `${pointer}: pointer must be a regular file`);
  const pointerState = entry
    ? (readFileSync(pointer, 'utf8') === instructionFor(root, indexRepo) ? 'present' : 'different')
    : 'missing';
  console.log(`Pointer: ${pointer} (${pointerState})`);
  if (!lstatSync(index, { throwIfNoEntry: false })) {
    console.log('Index clone: missing');
    return;
  }
  const branch = indexBranch(config);
  console.log(`Index clone: ${indexUrl ? localState(index, branch) : (
    git(index, 'status', '--porcelain=v1', '--untracked-files=all') ? 'has local changes' : 'clean')}`);
  const manifest = readManifest(index);
  const published = committedRecord(index);
  console.log(`Repositories: ${manifest.repositories.length}`);
  for (const repository of manifest.repositories) {
    const clonePath = join(root, repository.name);
    const clone = inspectClone(clonePath, repository.url);
    const cloneState = clone.state === 'missing' ? 'not cloned'
      : clone.state === 'matching' ? localState(clonePath, repository.branch) : 'foreign origin';
    const revision = published[repository.name];
    console.log(`${repository.name}: ${revision ? `published ${revision.slice(0, 12)}` : 'not published'}; clone ${cloneState}`);
  }
  if (!checkout) return;
  const source = git(checkout, 'rev-parse', '--show-toplevel');
  const origin = tryGit(source, 'remote', 'get-url', 'origin');
  const projectBranch = git(source, 'branch', '--show-current');
  console.log(`Project: ${source}`);
  console.log(`Project branch: ${projectBranch || 'detached HEAD'}`);
  const upstream = tryGit(source, 'rev-list', '--count', '@{upstream}..HEAD');
  console.log(`Project unpushed commits: ${upstream.status === 0 ? upstream.stdout.trim() : 'no upstream'}`);
  console.log(`Project documentation: ${existsSync(join(source, ...CATALOG.split('/'))) ? 'present' : 'missing'}`);
  if (origin.status !== 0) {
    console.log('Project registration: no origin remote');
    return;
  }
  const repository = manifest.repositories.find(item => sameOrigin(item.url, origin.stdout.trim()));
  const localDefault = tryGit(source, 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD');
  const defaultBranch = repository?.branch
    ?? (localDefault.status === 0 ? localDefault.stdout.trim().replace(/^origin\//, '') : '');
  const tracking = `refs/remotes/origin/${defaultBranch}`;
  const hasTracking = defaultBranch && tryGit(source, 'rev-parse', '--verify', '--quiet', tracking).stdout.trim();
  const current = hasTracking ? git(source, 'log', '-1', '--format=%H', tracking, '--', CATALOG) : '';
  const recorded = repository && published[repository.name];
  const state = !hasTracking ? `origin/${defaultBranch || '<default branch>'} not fetched`
    : !current ? `no catalog on origin/${defaultBranch}`
      : current === recorded ? 'published'
        : `publication pending (catalog ${current.slice(0, 12)} on origin/${defaultBranch}, `
          + `published ${recorded ? recorded.slice(0, 12) : 'never'})`;
  console.log(repository
    ? `Project registration: ${repository.name} on ${repository.branch}, owner ${repository.owner}, `
      + `area ${repository.area}; ${state}`
    : `Project registration: not registered; ${state}`);
}

async function connect(root, indexRepo, indexUrl) {
  assert(validName(indexRepo), `Invalid index repository name ${indexRepo}`);
  oneLine(indexUrl, 'index repository URL');
  const home = homedir();
  checkPersonalPaths(home);
  const index = join(root, indexRepo);
  const existing = inspectClone(index, indexUrl);
  if (existing.state === 'missing') {
    assert(!remoteIsEmpty(indexUrl), `${indexUrl} is an empty repository; create a new index there instead`);
  }
  const instruction = instructionFor(root, indexRepo);
  await confirmPointer(home, instruction);
  mkdirSync(root, { recursive: true });
  assert(lstatSync(root).isDirectory(), `${root}: clone root must be a directory, not a link`);
  if (existing.state === 'missing') {
    cloneRepository(index, indexUrl);
    console.log(`Cloned ${index}`);
  } else {
    assert(existing.state === 'matching', `${index}: origin differs from ${indexUrl} (actual ${existing.origin})`);
  }
  const config = { root, indexRepo, indexUrl, index };
  indexBranch(config);
  const manifest = readManifest(index);
  for (const repository of manifest.repositories) {
    assert(repository.name.toLowerCase() !== indexRepo.toLowerCase(),
      `${repository.name}: manifest repository name collides with the index repository`);
  }
  assert(lstatSync(join(index, 'llms.txt'), { throwIfNoEntry: false })?.isFile(),
    `${index}: missing root llms.txt or not a regular file`);
  writePersonalFiles(home, { root, indexRepo, indexUrl }, instruction);
  console.log(`Connected to ${indexUrl}: ${manifest.repositories.length} repositories; none cloned (on demand).`);
}

async function create(root, indexRepo, title, indexUrl = null) {
  assert(validName(indexRepo), `Invalid index repository name ${indexRepo}`);
  oneLine(title, 'index title');
  if (indexUrl !== null) {
    oneLine(indexUrl, 'index repository URL');
    assert(remoteIsEmpty(indexUrl), `${indexUrl} already has content; connect to it instead of creating a new index`);
  }
  const home = homedir();
  checkPersonalPaths(home);
  const index = join(root, indexRepo);
  const entry = lstatSync(index, { throwIfNoEntry: false });
  assert(!entry || (entry.isDirectory() && !readdirSync(index).length), `${index}: already exists and is not empty`);
  const instruction = instructionFor(root, indexRepo);
  await confirmPointer(home, instruction);
  mkdirSync(index, { recursive: true });
  let created;
  try {
    execFileSync('git', ['init', '--quiet', '--initial-branch=main', index], { stdio: ['ignore', 'pipe', 'pipe'] });
    generate(index, { manifest: { title, purpose: DEFAULT_PURPOSE, repositories: [] }, taxonomy: { areas: [] } });
    git(index, 'add', '--all');
    git(index, 'commit', '--quiet', '-m', 'Create organization reuse index');
    created = git(index, 'rev-parse', 'HEAD');
    if (indexUrl !== null) {
      git(index, 'remote', 'add', 'origin', indexUrl);
      git(index, 'push', '--quiet', '-u', 'origin', 'main');
    }
  } catch (error) {
    // A push can reach the remote and still report failure; then keep the index.
    const remote = created && indexUrl !== null
      ? spawnSync('git', ['ls-remote', '--', indexUrl, 'refs/heads/main'], { encoding: 'utf8', env: gitEnv })
      : null;
    if (remote?.status === 0 && remote.stdout.startsWith(created)) {
      git(index, 'update-ref', 'refs/remotes/origin/main', created);
      git(index, 'branch', '--quiet', '--set-upstream-to=origin/main', 'main');
    } else {
      // Everything in the directory was created by this invocation and nothing was pushed.
      for (const name of readdirSync(index)) rmSync(join(index, name), { recursive: true, force: true });
      if (!entry) rmSync(index, { recursive: true, force: true });
      throw new Error(`${error.message}\nThe new index was removed again; fix the problem and run create again.`);
    }
  }
  if (indexUrl !== null) {
    git(index, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
    console.log(`Pushed ${index} to ${indexUrl}`);
  } else {
    console.log(`Created ${index} without a remote; other developers cannot connect to it.`);
  }
  writePersonalFiles(home, { root, indexRepo, indexUrl }, instruction);
}

// Rewrites the personal files for the configured index, for example after the
// helper moved to another install location; also works for a local-only index.
async function repair() {
  const config = requireConfig();
  const { home, root, indexRepo, indexUrl, index } = config;
  checkPersonalPaths(home);
  assert(lstatSync(index, { throwIfNoEntry: false }), indexUrl
    ? `${index}: index clone is missing; run connect with ${indexUrl} instead`
    : `${index}: the local-only index is missing and cannot be repaired`);
  indexBranch(config);
  assert(lstatSync(join(index, 'llms.txt'), { throwIfNoEntry: false })?.isFile(),
    `${index}: missing root llms.txt or not a regular file`);
  const instruction = instructionFor(root, indexRepo);
  await confirmPointer(home, instruction);
  writePersonalFiles(home, { root, indexRepo, indexUrl }, instruction);
  console.log(`Repaired the personal files for ${index} (${indexUrl ?? 'local only, no remote'})`);
}

function ensure(name) {
  const config = requireConfig();
  refreshIndex(config, { strict: false });
  if (name === undefined) {
    console.log(`Index: ${join(config.index, 'llms.txt')}`);
    return;
  }
  const manifest = readManifest(config.index);
  const repository = manifest.repositories.find(item => item.name === name)
    ?? manifest.repositories.find(item => item.name.toLowerCase() === name.toLowerCase());
  assert(repository, `${name}: not in the index manifest (known: ${manifest.repositories.map(item => item.name).join(', ') || 'none'})`);
  assert(repository.name.toLowerCase() !== config.indexRepo.toLowerCase(),
    `${repository.name}: manifest repository name collides with the index repository`);
  const checkout = join(config.root, repository.name);
  const existing = inspectClone(checkout, repository.url);
  if (existing.state === 'missing') {
    cloneRepository(checkout, repository.url, repository.branch);
    console.log(`${repository.name}: cloned ${repository.branch} into ${checkout}`);
    return;
  }
  assert(existing.state === 'matching',
    `${checkout}: foreign origin; expected ${repository.url}, actual ${existing.origin}; left unchanged`);
  const state = localState(checkout, repository.branch);
  if (state.startsWith('on ') || state === 'has local changes') {
    console.log(`${repository.name}: ${state}; left unchanged at ${checkout}`);
    return;
  }
  let tracking;
  try {
    tracking = fetchBranch(checkout, repository.branch);
  } catch (error) {
    console.log(`${repository.name}: could not fetch (${error.stderr?.trim() || error.message}); using local files at ${checkout}`);
    return;
  }
  const [ahead, behind] = aheadBehind(checkout, tracking);
  if (ahead) {
    console.log(`${repository.name}: diverged from origin/${repository.branch}; left unchanged at ${checkout}`);
  } else if (behind) {
    git(checkout, 'merge', '--ff-only', '--quiet', tracking);
    console.log(`${repository.name}: fast-forwarded ${checkout}`);
  } else {
    console.log(`${repository.name}: up to date at ${checkout}`);
  }
}

const GENERATED = /^(manifest\.json|areas\.json|llms\.txt|catalog-revisions\.json|area-[^/]+\.txt|catalogs\/[^/]+\.json)$/;

function registration(config, url, source, options) {
  const manifest = readManifest(config.index);
  const taxonomy = readAreas(config.index);
  let repository = manifest.repositories.find(item => sameOrigin(item.url, url));
  if (!repository) {
    const name = options.name ?? repositoryName(url);
    assert(validName(name), `Invalid repository name ${name}`);
    assert(!manifest.repositories.some(item => item.name.toLowerCase() === name.toLowerCase()),
      `${name}: another manifest repository already uses this name; pass --name`);
    assert(name.toLowerCase() !== config.indexRepo.toLowerCase(), `${name}: collides with the index repository`);
    assert(options.owner, '--owner is required to register a new repository');
    assert(options.area, '--area is required to register a new repository');
    repository = { name, url, branch: remoteDefaultBranch(source, { online: true }),
      owner: oneLine(options.owner, 'owner'), area: options.area };
    manifest.repositories.push(repository);
  } else {
    for (const field of ['name', 'owner', 'area']) {
      assert(options[field] === undefined || options[field] === repository[field],
        `${repository.name} is already registered with ${field} ${repository[field]}; change it in the index manifest`);
    }
  }
  if (!taxonomy.areas.some(area => area.id === repository.area)) {
    assert(options.areaTitle && options.areaDescription,
      `area ${repository.area} does not exist; pass --area-title and --area-description to create it`);
    taxonomy.areas.push({ id: repository.area, title: oneLine(options.areaTitle, 'area title'),
      description: oneLine(options.areaDescription, 'area description') });
  }
  return { repository, manifest, taxonomy };
}

function readPublication(source, repository) {
  const tracking = fetchBranch(source, repository.branch);
  assert(git(source, 'ls-tree', '--name-only', tracking, '--', CATALOG) === CATALOG,
    `${repository.name}: origin/${repository.branch} has no ${CATALOG} yet; merge the documentation into ${repository.branch} first`);
  const revision = git(source, 'log', '-1', '--format=%H', tracking, '--', CATALOG);
  return {
    name: repository.name, revision, text: gitRaw(source, 'show', `${tracking}:${CATALOG}`),
    pageExists: page => tryGit(source, 'cat-file', '-t', `${tracking}:${page}`).stdout.trim() === 'blob',
  };
}

// Undo only this invocation's work: its own commit and the generated paths it may have added.
function undoPublication(index, before, ours) {
  const head = git(index, 'rev-parse', 'HEAD');
  assert(head === before || head === ours,
    `${index}: HEAD moved to ${head} during publication; inspect the index clone before retrying`);
  git(index, 'reset', '--quiet', '--hard', before);
  git(index, 'clean', '--quiet', '-fd', '--', 'catalogs', 'area-*.txt');
}

function publish(sourcePath, options) {
  const config = requireConfig();
  const { index } = config;
  const source = git(sourcePath, 'rev-parse', '--show-toplevel');
  const origin = tryGit(source, 'remote', 'get-url', 'origin');
  assert(origin.status === 0, `${source}: the repository has no origin remote to publish from`);
  const url = origin.stdout.trim();
  assert(lstatSync(index, { throwIfNoEntry: false })?.isDirectory(),
    `${index}: index clone is missing; run /docs-index to connect again`);
  const lock = join(git(index, 'rev-parse', '--absolute-git-dir'), 'repository-docs-publish.lock');
  try {
    writeFileSync(lock, `${process.pid}\n`, { flag: 'wx' });
  } catch (error) {
    assert(error.code !== 'EEXIST', `${index}: another publication is running (${lock}); if none is, delete that file and retry`);
    throw error;
  }
  try {
    publishLocked(config, source, url, options);
  } finally {
    rmSync(lock, { force: true });
  }
}

function publishLocked(config, source, url, options) {
  const { index } = config;
  let branch = refreshIndex(config, { strict: true });
  let publication;
  for (let attempt = 1; ; attempt += 1) {
    const { repository, manifest, taxonomy } = registration(config, url, source, options);
    publication ??= readPublication(source, repository);
    const short = publication.revision.slice(0, 12);
    const before = git(index, 'rev-parse', 'HEAD');
    let ours;
    try {
      const { touched } = generate(index, { manifest, taxonomy, publication });
      const paths = [...new Set(touched.map(file => (file.startsWith('catalogs/') ? 'catalogs' : file)))];
      git(index, 'add', '--all', '--', ...paths);
      const staged = git(index, 'diff', '--cached', '--name-only').split('\n').filter(Boolean);
      const unexpected = staged.filter(file => !GENERATED.test(file));
      assert(!unexpected.length, `${index}: unexpected changes ${unexpected.join(', ')}; nothing was published`);
      if (!staged.length) {
        console.log(`Index already up to date for ${repository.name} at ${short}.`);
        return;
      }
      git(index, 'commit', '--quiet', '-m', `Publish ${repository.name} catalog ${short}`);
      ours = git(index, 'rev-parse', 'HEAD');
    } catch (error) {
      undoPublication(index, before, before);
      throw error;
    }
    if (!config.indexUrl) {
      console.log(`Published ${repository.name} at ${short} in the local index only; `
        + 'it has no remote, so other developers cannot see it.');
      return;
    }
    const target = options.viaBranch ? `reuse/${repository.name}-${short}` : branch;
    const pushed = tryGit(index, 'push', '--quiet', 'origin', `HEAD:refs/heads/${target}`);
    if (pushed.status === 0) {
      if (options.viaBranch) {
        undoPublication(index, before, ours);
        console.log(`Pushed branch ${target}. ACTION REQUIRED: open a pull request into ${branch} in the index `
          + 'repository; the index is not updated until it is merged.');
      } else {
        console.log(`Published ${repository.name} at ${short} to ${config.indexUrl} (${branch}).`);
      }
      return;
    }
    undoPublication(index, before, ours);
    const fetched = tryGit(index, 'fetch', '--no-tags', '--no-write-fetch-head', 'origin',
      `+refs/heads/${branch}:refs/remotes/origin/${branch}`);
    const raced = !options.viaBranch && fetched.status === 0
      && git(index, 'rev-parse', `refs/remotes/origin/${branch}`) !== before;
    if (raced && attempt < 3) {
      console.log(`index: ${branch} moved while publishing; retrying on the new state`);
      branch = refreshIndex(config, { strict: true });
      continue;
    }
    throw new Error(`Push to ${target} failed; the local index commit was undone.\n${pushed.stderr.trim()}\n`
      + (raced ? 'The index kept moving; run publish again.'
        : `If ${branch} is protected, rerun publish with --via-branch and open a pull request.`));
  }
}

function parsePublish(args) {
  const options = {};
  const positional = [];
  const flags = { '--name': 'name', '--owner': 'owner', '--area': 'area',
    '--area-title': 'areaTitle', '--area-description': 'areaDescription' };
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--via-branch') {
      options.viaBranch = true;
    } else if (Object.hasOwn(flags, args[i])) {
      assert(i + 1 < args.length, `${args[i]} needs a value`);
      options[flags[args[i]]] = args[i += 1];
    } else {
      assert(!args[i].startsWith('--'), `Unknown option ${args[i]}`);
      positional.push(args[i]);
    }
  }
  assert(positional.length === 1, 'publish needs exactly one repository checkout');
  return [resolve(positional[0]), options];
}

const usage = 'Usage: reuse.mjs status [<project checkout>]\n'
  + '       reuse.mjs connect <root> <indexRepo> <indexUrl>\n'
  + '       reuse.mjs create <root> <indexRepo> <title> [<empty remote URL>]\n'
  + '       reuse.mjs repair\n'
  + '       reuse.mjs ensure [<repository>]\n'
  + '       reuse.mjs publish <project checkout> [--name <n>] [--owner <o>] [--area <id>]\n'
  + '             [--area-title <t> --area-description <d>] [--via-branch]\n'
  + '       reuse.mjs generate <index checkout>';

if (process.argv[1] && resolve(process.argv[1]) === helper) {
  try {
    const [command, ...args] = process.argv.slice(2);
    if (command === 'status' && args.length <= 1) {
      status(args[0] && resolve(args[0]));
    } else if (command === 'connect' && args.length === 3) {
      await connect(resolve(oneLine(args[0], 'root')), args[1], args[2]);
    } else if (command === 'create' && (args.length === 3 || args.length === 4)) {
      await create(resolve(oneLine(args[0], 'root')), args[1], args[2], args[3] ?? null);
    } else if (command === 'repair' && args.length === 0) {
      await repair();
    } else if (command === 'ensure' && args.length <= 1) {
      ensure(args[0]);
    } else if (command === 'publish') {
      publish(...parsePublish(args));
    } else if (command === 'generate' && args.length === 1) {
      generate(resolve(args[0]));
    } else {
      throw new Error(usage);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
