# sf-core -- Agent Guide

Shared TypeScript library used by the ApexSense and MetaWrench language
servers. `src/index.ts` exports three modules:

| Module | Holds |
|---|---|
| `salesforce` | `cli.ts` (the only `sf` launcher), `connection.ts` (authenticated Tooling, REST and Metadata API access), `sourceMetadata.ts` (source component resolution) |
| `telemetry` | Usage telemetry service, state, store and transport |
| `ownership` | Project ownership |

Commands: `npm run build`, `npm run lint`, `npm test`. Tests sit beside the
source as `*.test.ts`.

Salesforce API and CLI behaviour: look it up, do not answer from memory.
Search the local guides in `../Salesforce-API-Docs/` first (start with its
`INDEX.md`; never read a guide whole; the folder is outside this repo, so
pass its path explicitly when searching), then the `salesforce-docs` MCP
server. Say which source you used.

## Rules for this repo

- **Two consumers depend on every export.** Removing or changing an exported
  name or signature is a breaking change: update both consumers in the same
  piece of work, or keep the old export.
- **`src/salesforce/cli.ts` is the only production file that may import
  `child_process`.** Arguments are an array; `shell` stays `false`.
- **`sf` CLI v2 only, never `sfdx`.**
- **All HTTP to Salesforce goes through `src/salesforce/connection.ts`.** No
  tokens in logs, errors, telemetry or tests.
- **No `console.*`.** Both consumers speak LSP over stdout.
- **No `any` in production code**; use `unknown` with type guards.
- **Every promise is awaited, returned, or discarded with `void`.**
- **`npm run lint` passes.** It enforces the `child_process`, `console`,
  `any` and promise rules above.
- **Runtime dependencies are pinned exactly.** Do not add one or change a
  version without asking.

## Rules for consumers (canonical text)

- Server code calls `sf` only through the consumer's `src/utils/sfCli.ts`,
  which delegates to `salesforce.runCli`. Arguments are separate array items.
- Use the workspace root as `cwd` and the remembered per-root target org.
  `sf org display --json` at initialisation is the only normal unpinned call.
- Org access that is not the CLI goes through `salesforce.*` functions from
  this library, never hand-rolled HTTP.

## Landing a change

Consumers use this repo as a `vendor/sf-core` git submodule
(`sf-core: file:vendor/sf-core`) whose `origin` is this local folder. Every
consumer build runs `scripts/setup-sf-core.cjs`, which syncs the submodule
to its **pinned** commit and rebuilds `dist`. Edits here reach a consumer
only when its pointer is bumped with `npm run upgrade:sf-core`, which moves
it to this repo's `main` and commits the pointer.

When a change is finished and verified, not after each intermediate edit:

1. Commit here on `main` first, so the new state exists as a real commit.
2. In each consumer, check the worktree is clean. If it is dirty, STOP, offer
   options and ask how to proceed.
3. Run the consumer's `npm run upgrade:sf-core`, then its build and its
   telemetry and sfCli tests.

Never leave a consumer pointing at a commit that does not exist here;
abandoned history breaks every later `setup:sf-core`. If you find a consumer
behind the latest commit while doing unrelated work, report it; do not bump
it as a side effect.
