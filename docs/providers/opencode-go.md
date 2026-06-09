# OpenCode Go

> Uses local OpenCode history from SQLite to track observed OpenCode Go spend on this machine.

## Overview

- **Source of truth:** `~/.local/share/opencode/opencode.db`
- **Auth discovery:** `~/.local/share/opencode/auth.json`
- **Provider ID:** `opencode-go`
- **Usage scope:** local observed assistant spend only

## Detection

The plugin enables when either condition is true:

- `~/.local/share/opencode/auth.json` contains an `opencode-go` or `opencode` entry with a non-empty `key`
- local OpenCode history already contains `opencode-go` assistant messages with numeric `cost`
- local OpenCode session history already contains token usage

If neither signal exists, the plugin stays hidden.

## Data Source

OpenUsage reads the local OpenCode SQLite database directly. Current OpenCode versions store usage on `session`:

```sql
SELECT
  time_created,
  json_extract(model, '$.id') AS modelId,
  json_extract(model, '$.providerID') AS providerId,
  tokens_input,
  tokens_output,
  tokens_reasoning,
  tokens_cache_read,
  tokens_cache_write,
  cost
FROM session
```

Only rows whose model provider is `opencode` are estimated as Go usage. `*-free` models count as `$0`. Other provider rows, such as Ollama cloud history with similar model names, are ignored.

Older OpenCode history is still supported through assistant messages:

```sql
SELECT
  CAST(COALESCE(json_extract(data, '$.time.created'), time_created) AS INTEGER) AS createdMs,
  CAST(json_extract(data, '$.cost') AS REAL) AS cost
FROM message
WHERE json_valid(data)
  AND json_extract(data, '$.providerID') = 'opencode-go'
  AND json_extract(data, '$.role') = 'assistant'
  AND json_type(data, '$.cost') IN ('integer', 'real')
```

Only assistant messages with numeric `cost` count. Missing remote or other-device usage is not estimated.

When current `session.cost` is `0`, OpenUsage estimates cost from the local token columns using the published OpenCode Go prices per 1M tokens. If OpenCode later records a non-zero local `cost`, that value is used directly.

## Limits

OpenUsage uses the current published OpenCode Go plan limits from the official docs:

- `5h`: `$12`
- `Weekly`: `$30`
- `Monthly`: `$60`

Bars show observed local spend against those fixed dollar limits.

## Window Rules

- `5h`: rolling last 5 hours from now
- `Weekly`: UTC Monday `00:00` through the next UTC Monday `00:00`
- `Monthly`: inferred subscription-style monthly window using the earliest local OpenCode Go usage timestamp as the anchor

Monthly usage is inferred from local history, not read from OpenCode’s account API. OpenUsage reuses the earliest observed local OpenCode Go usage timestamp as the monthly anchor. If no local history exists yet, it falls back to UTC calendar month boundaries until the first Go usage is recorded.

## Failure Behavior

If auth or prior history already indicates OpenCode Go is in use, but SQLite becomes unreadable or malformed, the provider stays visible and shows a grey `Status: No usage data` badge instead of failing hard.

## Future Compatibility

The public provider identity stays `opencode-go`. If OpenCode later exposes account-truth usage by API key, OpenUsage can swap the backend without changing the provider ID or UI contract.
