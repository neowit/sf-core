## Salesforce CLI

Use Salesforce CLI v2 (`sf`) only. Never use `sfdx`. All server-side CLI calls
go through `src/utils/sfCli.ts`, with arguments passed as separate array items.
Use the workspace root as `cwd` and the remembered per-root target. The init
`sf org display --json` call is the only normal unpinned initialization call.

Retrieval always targets a dedicated temporary output directory. Read-only
operations never overwrite project files and never fall back to an unscoped
retrieve when the CLI result is empty.

## Consumers (ApexSense + MetaWrench)

Both `../apexsense-lsp-private` and `../metawrench-lsp-private` consume this
repo via a `vendor/sf-core` git submodule (`sf-core: file:vendor/sf-core`),
synced and rebuilt by each project's `scripts/upgrade-sf-core.cjs` on every
build. Working-tree edits here never reach the consumers on their own.

Sync the consumers only once an sf-core change is finished and verified --
not after every intermediate edit during multi-task work. When it is ready
to land, in this order:
1. Commit here first, so the new state exists as a real commit.
2. In each consumer: make sure that worktree is clean. 
    - If consumer worktree is dirty then STOP, offer potential options and ask the user how to proceed.
3. Run the consumer's `npm run upgrade:sf-core` (to bump vendor/sf-core to latest origin/main and rebuild `dist`) plus its build and
   telemetry/sfCli tests.

Never leave a consumer pointing at a commit that does not exist upstream
(orphaned/abandoned history breaks every future `setup:sf-core` sync), and
never leave pointers behind latest -- MetaWrench once pinned an abandoned
line whose `runCli` invocation API no longer exists, which broke its build
on bump.


