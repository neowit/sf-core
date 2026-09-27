## Salesforce CLI

Use Salesforce CLI v2 (`sf`) only. Never use `sfdx`. All server-side CLI calls
go through `src/utils/sfCli.ts`, with arguments passed as separate array items.
Use the workspace root as `cwd` and the remembered per-root target. The init
`sf org display --json` call is the only normal unpinned initialization call.

Retrieval always targets a dedicated temporary output directory. Read-only
operations never overwrite project files and never fall back to an unscoped
retrieve when the CLI result is empty.

