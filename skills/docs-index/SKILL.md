---
name: "docs-index"
description: "Set up the organization reuse index on this machine: report an index that already exists, connect to an existing index by its Git URL, or create a new one. Use for requests like \"set up the docs index\", \"connect to our reuse index\" or \"create an organization index\"."
compatibility: "Requires Node.js 22+ and Git. Creating a remote index repository uses the GitHub CLI (gh) or Azure CLI (az). Resolve package links from this skill's installed source, not the current project."
---

# Set up the organization reuse index

Do every step yourself; the user only answers the questions below. Follow the
[documentation policy](../../references/documentation-policy.md) and the
[index reference](../../references/reuse-index.md). Run the
[helper](../../scripts/reuse.mjs) from this skill's package root as
`node "<package root>/scripts/reuse.mjs" <command>`.

1. **Report an existing index.** Run `status`. If an index is configured, its
   clone is present and the pointer is `present`, tell the user the index
   already exists: its path, its remote URL (or local only) and how many
   repositories are published. Change nothing and stop. If the configuration
   exists but the pointer is missing or different while the clone is present,
   say so and offer one repair, for a remote or a local-only index alike: show
   the old and new instruction (the helper path changes when the plugin is
   installed elsewhere), ask one confirmation, then run `repair`, piping `yes`
   only when the user approved replacing a different instruction. If the clone
   is missing, offer `connect` with the configured root, index name and URL
   instead. A lost local-only index cannot be repaired; report that and stop.

2. **Ask for an existing index.** Otherwise ask whether the user has the Git URL
   of an existing organization index repository. If they do, take the URL.

3. **Choose where clones live.** Propose the clone root: the folder that holds
   the current repository's main checkout (for `D:\git\<project>` or an app
   worktree of it, `D:\git`), else a `git` folder in the home directory. Propose
   the index folder name: the repository name from the URL, else `reuse-index`.
   Other repositories will be cloned beside it **on demand**, only when an agent
   needs one.

4. **Connect.** Tell the user exactly what happens: only the index is cloned to
   `<root>/<name>`; the configuration `~/.org-reuse/config.json` and the
   always-loaded instruction `~/.copilot/instructions/org-reuse.instructions.md`
   are written (show the resolved paths, and the old and new instruction when
   one exists with different content). Ask one confirmation, then run
   `connect <root> <name> <url>`, piping `yes` only when the user approved
   replacing a different instruction. If the helper reports an empty remote,
   continue with step 5 using that URL for the remote option.

5. **No index yet.** If the user has no URL, explain the options and their
   consequences, then ask which one to take:
   - **Stop.** Nothing changes. `/docs-create` and `/docs-update` cannot
     publish until an index exists.
   - **New index with a remote repository.** Creates a private repository on
     GitHub (`gh repo create <owner>/<name> --private`) or Azure DevOps
     (`az repos create --name <name> --project <project>`) without any initial
     commit, then the index locally, and pushes it. Teammates connect by running
     `/docs-index` with its URL. Needs permission to create repositories; ask
     for the owner or project, name and index title.
   - **Local-only index.** Created only on this machine. Publications stay here:
     no other developer, machine or agent elsewhere can use them until the index
     is pushed to a remote.

   After the user chooses, show the paths and personal files as in step 4, then
   run `create <root> <name> "<title>" [<url>]`.

6. **Report.** State what was cloned or created and the two personal files.
   End with `Action required`: start a new Copilot session so the instruction
   loads; for a remote index, share its URL with teammates, who each run
   `/docs-index`; run `/docs-create` in each repository whose libraries or
   integrations other projects should reuse.
