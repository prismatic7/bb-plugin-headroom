# bb-plugin-headroom

Context budget monitoring for BB coding agents. Tracks how much of the model's
context window a thread has used and tells the agent when it's time to
summarise or start fresh.

## Tools

- **`headroom_status`** — reports the provider's context window, estimated
  tokens used (message count × rough average), remaining headroom, and a
  green / yellow / red recommendation. Call it before starting a large batch
  of work or when a conversation gets long.

## Background monitor

Listens to `thread.created`, `thread.active`, `thread.idle`, `thread.archived`
and `thread.deleted` events, tracks per-thread message counts, and logs a
warning or critical alert when a thread crosses the configured thresholds.

## Settings

| Setting | Default | Description |
|---|---|---|
| `warningThreshold` | `70` | Log a warning when context usage exceeds this percentage. |
| `criticalThreshold` | `85` | Log a critical alert when context usage exceeds this percentage. |

## Install

```sh
npm install
bb plugin install .
```

After editing sources, reload:

```sh
bb plugin reload headroom
```

## Configure

```sh
bb plugin config headroom
bb plugin config headroom set warningThreshold 80
```

## Build

```sh
bb plugin build
```
