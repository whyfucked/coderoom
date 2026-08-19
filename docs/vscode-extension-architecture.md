# CodeRoom VS Code extension architecture

## Existing runtime

`src/agent.mjs` owns the complete agent loop: prompt construction, streaming model
requests, tool calls, permission checks, execution, retries, compaction and session
persistence. `src/provider.mjs`, `src/tools.mjs`, `src/permissions.mjs` and
`src/session.mjs` are already UI-independent enough to reuse directly.

The CLI remains an adapter around that runtime. The extension does not fork the
agent or provider implementation.

## Dependency graph

```text
VS Code Chat Participant / commands / tree views
                    |
            VS Code adapter layer
                    |
       Agent + Session + Provider (shared)
                    |
       tools + permissions + configuration
                    |
          workspace filesystem / shell / API
```

The extension entry point imports the shared ESM modules. esbuild follows and
bundles those imports into the VSIX, so the installed extension is standalone
while the source of truth remains the CLI runtime.

## VS Code-specific responsibilities

- `apps/coderoom-vscode/src/extension.ts`: activation, native Chat Participant,
  commands, cancellation, streamed progress and human-readable errors.
- `runtime.ts`: maps VS Code workspace/editor/diagnostic context and SecretStorage
  into the shared runtime configuration.
- `model-manager.ts`: model catalogue, cached real health checks and selection.
- `views.ts`: Activity Bar model/session trees.
- `logger.ts`: redacted OutputChannel logging.

The shared tools stay workspace-restricted through `safeResolve`. Mutating calls
run through the existing `PermissionEngine`; the extension forces `default` or
the user-selected VS Code permission mode instead of inheriting the CLI's yolo
default. WebFetch and SSH are excluded from the VS Code agent surface.

## State and secrets

Conversation files retain the existing CodeRoom session format. The API key is
read from VS Code SecretStorage and injected only into the in-memory config; it
is never written to `settings.json` or the CodeRoom config file by the extension.

## Validation

The extension has unit tests for context budgeting, health-state classification
and permission-mode mapping. Build and type checks cover the VS Code adapter,
and the existing CLI smoke suite remains the regression gate for shared code.
