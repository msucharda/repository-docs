# Repository Docs

A GitHub Copilot plugin that helps teams stop reimplementing what another
repository in their organization already provides. It documents each
repository's reusable libraries and integrations for other projects, publishes
them in an organization reuse index, and points every agent at that index.

You use three skills. Each one does its own research, review and Git work, asks
you once before committing or publishing anything, and ends by telling you
exactly what, if anything, is left for you to do.

| Skill | What it does |
| --- | --- |
| [`/docs-index`](skills/docs-index/SKILL.md) | Sets up the organization reuse index on your machine. If one is already set up, it just says so. Otherwise it connects to an existing index by its Git URL, or, if there is none, explains your options and creates one (with or without a remote repository). |
| [`/docs-create`](skills/docs-create/SKILL.md) | Documents the current repository's reusable libraries and integrations in `docs/reuse/`, has the drafts reviewed independently, and after your confirmation commits, pushes and publishes them to the index. |
| [`/docs-update`](skills/docs-update/SKILL.md) | Brings that documentation up to date after code changes and publishes it, including documentation that was merged into the default branch since the last publication. |

## Status

Version `1.0.1`. Developed and evaluated with GitHub Copilot CLI, mostly on
synthetic fixtures:

- With one always-loaded instruction pointing to the reuse index, fresh agents
  reused the right library in every synthetic cross-repository run; without
  the pointer they almost always reimplemented it.
- Reuse pages cut exploration by 30-45%, but did not change correctness
  against small, readable libraries.

Version `1.0.0`, the first stable release, installs from this repository's
plugin marketplace and pins the models of the internal agents. Version `1.0.1`
lets `/docs-index` repair the personal instruction of a local-only index. The
helper is covered by local fixture tests and the skills have been used on real
repositories; on-demand cloning by agents, real GitHub or Azure DevOps
organizations, and hosts other than Copilot have not been evaluated yet.
Review by an agent is advisory, not a guarantee.

## Install

Requires GitHub Copilot CLI, Node.js 22+ and Git. The helper uses only Node
built-ins, so there is nothing to `npm install`.

This repository is also a plugin marketplace named `repository-docs`. Register
it once, then install the plugin from it:

```powershell
copilot plugin marketplace add msucharda/repository-docs
copilot plugin install repository-docs@repository-docs
```

In an interactive session, use `/plugin marketplace add` and `/plugin install`
with the same arguments. In the GitHub Copilot app, browse marketplaces and
install plugins under **Customize** > **Plugins**. Copilot CLI has
deprecated direct installs from a repository (`copilot plugin install
msucharda/repository-docs`); only `plugin@marketplace` installs remain
supported.

Start a **new** session; `/skills list` shows the three skills. Installing does
not change any repository. To get a newer version, run `copilot plugin update
repository-docs`.

If you installed the plugin directly from the repository before, run
`copilot plugin uninstall repository-docs`, install it from the marketplace as
above and run `/docs-index` in a new session. The helper path changes with the
install location, so `/docs-index` reports the personal instruction as
different and offers to repair it.

## Models

The skills run on the model of your session; a plugin cannot select it. Select
GPT-6.1 Sol with `xhigh` reasoning effort (`/model`) before you run a skill.

The internal agents select their own models: `repository-discovery` runs on
GPT-6.1 Sol and `documentation-reviewer` on Claude Opus 5.5, both with `xhigh`
reasoning effort. The review therefore comes from a different model family than
the drafts. Both models must be available under your Copilot plan and policies.

## How it fits together

1. One person runs `/docs-index` and creates the index, preferably with a remote
   repository, and shares its URL.
2. Every developer runs `/docs-index` once with that URL. Only the index is
   cloned, into a folder such as `D:\git\<index>`. A personal instruction makes
   every new agent session read the index before writing an integration, API
   client, data extractor or shared utility.
3. In each repository worth reusing, someone runs `/docs-create`. If the
   documentation lands on a feature branch, the skill tells you to merge it and
   then run `/docs-update`, which publishes it.
4. When code changes, `/docs-update` updates the pages and the index.
5. When an agent elsewhere needs a documented repository, it clones it on
   demand beside the index, or fast-forwards an existing clean clone.

The index stores routing files and a copy of each published catalog, so
publishing or searching never requires cloning the whole organization. See the
[index reference](references/reuse-index.md) for its layout and helper commands
and the [reuse workflow](references/reuse-workflow.md) for how documentation is
researched, reviewed and published.

## Scope

The plugin writes only uncommitted drafts before your confirmation; after it,
it commits only its own files, never force-pushes or merges pull requests, and
outside repositories writes only two personal files that `/docs-index` shows
first. No MCP server, hooks, telemetry or CI is included, and the helper never
runs repository code. The two internal agents use Copilot's agent directory;
other clients may ignore them.

## License

[MIT](LICENSE). Upstream notices for adapted ideas are in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
