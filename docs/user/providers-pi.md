# Pi

T3 Code can run Pi through Pi's RPC mode. Pi keeps control of its models, accounts, extensions,
skills, tools, configuration, and session files.

## Set Up Pi

Install and configure Pi first. Confirm that the command works in the same environment as the T3
server:

```bash
pi --version
```

Then open **Settings**, add a **Pi** provider, and refresh its status. T3 uses `pi` from `PATH` by
default. Set **Binary path** when Pi lives elsewhere.

T3 marks the provider unavailable when it cannot run the configured binary.

## Models And Reasoning

T3 asks Pi for its current model list. Sign in to providers and manage custom models through Pi as
you normally would. T3 does not keep a separate fallback model list.

The model picker shows the models Pi reports. The reasoning picker only shows levels supported by
the selected model.

## Extensions, Commands, And Skills

T3 reads Pi's command catalog when it checks the provider:

- Pi extension and prompt commands appear in the `/` menu.
- Pi skills appear in both the `/skill:` menu and the `$` skill menu.
- Extension `select`, `confirm`, `input`, and `editor` requests use T3's user-input panel.
- Pi subagents and workflows appear in T3's Agents panel.
- The optional Pi `t3-browser` extension exposes T3's collaborative browser through one
  `t3_browser` tool.

Extensions must use Pi's RPC-compatible UI methods for remote input. TUI-only custom views cannot
run in RPC mode. The browser extension receives a credential scoped to the current T3 thread and
cannot call other T3 MCP toolkits.

## Sessions And Configuration

T3 stores the Pi session file path with each thread and resumes that same file later. It does not
copy or replace Pi's configuration directory. Changes made through Pi remain available in T3, and
changes made by a T3-hosted Pi session remain available to Pi.

You can set environment variables on each Pi provider instance in Settings. T3 passes them to the
Pi process without replacing the rest of the server environment.

## Current Limits

Pi sessions use **Full access** mode. T3 does not add an Executor or generic MCP layer to Pi, and
it does not support restoring a Pi turn from a T3 checkpoint. Pi's own tools and extensions still
run normally.
