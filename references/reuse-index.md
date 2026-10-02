# Organization reuse index

The index lets agents in any repository find reusable libraries and
integrations documented elsewhere in the organization. It is **routing only**:
each repository's `docs/reuse/` pages stay the single source of the
explanation. The [docs-index](../skills/docs-index/SKILL.md) skill connects or
creates it; [docs-create](../skills/docs-create/SKILL.md) and
[docs-update](../skills/docs-update/SKILL.md) publish into it through the
[helper](../scripts/reuse.mjs).

## Layout

The index is a Git repository cloned at `<root>/<indexRepo>`. Every other
repository it routes to resolves as a sibling, `<root>/<name>`, and is cloned
**on demand**, not up front.

| File | Content |
| --- | --- |
| `manifest.json` | `title`, `purpose` and `repositories`: each with `name`, `url`, `branch`, `owner` and default `area`. |
| `areas.json` | `areas`: each with `id`, `title` and a one-line consumer-task `description`. |
| `catalogs/<name>.json` | The published copy of each repository's `docs/reuse/catalog.json`. |
| `catalog-revisions.json` | The commit each published catalog was read from, and the generated areas. |
| `llms.txt` | Root index: areas, a search fallback over `catalogs/`, and the catalogs. |
| `area-<id>.txt` | One line per unit in that area, linking its page in the sibling clone. |

A repository `name` is its unique local folder name: letters, digits, dots,
underscores or hyphens, beginning and ending with a letter or digit, distinct
ignoring case. `owner` is a team, not an area. Area ids use letters, digits,
hyphens or underscores. Unknown fields are rejected. A catalog unit may set its
own `area` to override its repository's default; both must exist in
`areas.json`. Areas are consumer-facing tasks, never organization teams.

Because the published catalogs live in the index, publishing one repository
never needs any other repository cloned, and an agent can search every catalog
without cloning anything.

## The personal pointer and on-demand clones

`connect` and `create` write two personal files, and nothing else outside the
clone root:

- `~/.org-reuse/config.json` with the absolute `root`, `indexRepo` and
  `indexUrl` (`null` for a local-only index);
- `~/.copilot/instructions/org-reuse.instructions.md`, an always-loaded
  instruction (`applyTo: "**"`). It tells agents, before implementing an
  integration, API client, data extractor or shared utility, to run
  `node "<helper>" ensure`, read the absolute `<root>/<indexRepo>/llms.txt`, and
  run `node "<helper>" ensure <name>` before opening a link into another
  repository.

New sessions load the instruction; a session that was already running does not.
Agents also need read access to the clone root; the user approves reads outside
the project, or the session allows them.

`ensure` first refreshes the index: it fast-forwards a clean index clone on its
default branch and otherwise reports why it uses the local copy. With a name it
then handles that repository:

| Local state of `<root>/<name>` | Result |
| --- | --- |
| Missing | Cloned on the manifest branch. |
| Clean, on the manifest branch | Fetched and fast-forwarded; diverged clones are left unchanged. |
| Local changes or another branch | Left unchanged and reported; its files may differ from the manifest branch. |
| Different origin | Error; left unchanged. |
| Fetch fails | Reported; the local files are used. |

It never deletes, moves, renames, resets or merges a clone.

## Helper commands

Run from the package root as `node scripts/reuse.mjs <command>`.

| Command | Effect |
| --- | --- |
| `status [<project>]` | Read-only: configuration, pointer, index clone, published repositories with their local clone state and, for a project checkout, its branch, documentation and publication state. Uses local refs only. |
| `connect <root> <indexRepo> <url>` | Clones an existing index (only the index) and writes the personal files. Refuses an empty remote. |
| `create <root> <indexRepo> <title> [<url>]` | Creates a new empty index, pushes it to an empty remote when given, and writes the personal files. Refuses a remote with content. |
| `repair` | Rewrites the personal files for the configured index, remote or local-only, for example after the helper moved to another install location. Refuses a missing index clone. |
| `ensure [<name>]` | Refreshes the index, then clones or fast-forwards one repository as above. |
| `publish <project> [options]` | Publishes the project's committed catalog from its `origin` default branch. |
| `generate <index>` | Maintainer regeneration after editing `manifest.json` or `areas.json`. |

When the personal pointer exists with different content, `connect`, `create`
and `repair` print both versions and replace it only after `yes` on standard
input. Origins
match across GitHub HTTPS and SSH forms and Azure DevOps modern, SSH and legacy
`visualstudio.com` forms, ignoring a trailing `.git` and letter case. Commands
that write to the index ask the remote for its default branch, so a renamed
default branch is noticed.

## Publication

`publish <project>` refreshes the index and requires it to be clean, on its
default branch and not ahead of its remote. It finds the project in the manifest
by its `origin` URL. An unregistered project needs `--owner` and `--area`, and
`--area-title` with `--area-description` when the area is new; `--name`
overrides the default name taken from the URL.

It fetches the project's default branch and reads `docs/reuse/catalog.json` and
the pages it names **from `origin/<branch>`**, never from the working tree, so
uncommitted, unpushed or feature-branch documentation is not published; the
command fails with "merge the documentation into `<branch>` first". It then
stores the catalog in `catalogs/<name>.json`, records its revision, regenerates
the routing files within the size budget and commits. If nothing changed it
reports the index as up to date.

With a remote, it pushes to the index's default branch. When another developer
published at the same moment, it undoes its own commit, fast-forwards and
regenerates on the new state, and retries up to three times. Publications in
one index clone are serialized by a lock file in its Git directory. Any other
rejected push undoes the local commit and reports the error; rollback touches
only this publication's commit and generated files, and the command refuses an
index clone with unrelated changes. `--via-branch` instead pushes
`reuse/<name>-<revision>` for a pull request and leaves the local index on the
default branch; the index changes only when that pull request is merged. A
local-only index is published by local commit only.

If `create` fails before its push succeeds (for example a missing Git identity
or a rejected push), it removes the new index directory again, so the same
command can simply be rerun.

## Size budget and maintenance

Every routing file (`llms.txt`, each `area-<id>.txt` and
`catalog-revisions.json`) must fit in 16,384 bytes of UTF-8, below the measured
Copilot CLI file view limit of about 20 KB. Generation checks every output
before writing any; invalid input or an oversized file changes nothing.
Units and areas are sorted and no timestamps are written, so unchanged input
produces identical files. An area left without units is omitted and its file
removed.

When an area overflows or no area fits, the maintainer changes the taxonomy:
edits `areas.json` and manifest default areas in the index clone, runs
`generate <index>`, reviews and commits the diff and pushes it (through a pull
request when the branch is protected). A unit's own `area` override is part of
its repository's catalog and changes through `docs-update` there. Removing a
repository from `manifest.json` drops its routes and published catalog on the
next generation; its clones stay untouched. `generate` reads a sibling clone
(with the manifest origin, on its manifest branch, from its committed `HEAD`)
when present, and the published catalog otherwise.

## Evidence

On synthetic organizations, one always-loaded instruction pointing to the index
led fresh agents to the right library 9/9 times (1/9 without it); on local
clones side by side, with a request that did not mention reuse, 3/3 with the
pointer and 0/3 without. A skill whose description names the tasks activated
9/9 times but was ignored twice, so the always-loaded instruction stays the
primary route. These runs used pointers to pre-cloned repositories; on-demand
cloning through `ensure` has local fixture tests but no agent evaluation yet.

For local tests, redirect the home directory with `USERPROFILE` (Windows) or
`HOME` (Unix), set `COPILOT_HOME` to `<test-home>/.copilot`, and check
`copilot instruction list --json` for the generated file with
`location: "user"`.
