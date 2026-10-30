# Agent Mesh

DeepSeek Harness plugin. Agents open, message, watch and stop ordinary
sessions in other workspaces registered in DSH. Typical use: work spans two
repositories, and the agent in repo A delegates the part in repo B to an agent
that runs in B with B's own sandbox, instead of being given full access.

## Tools

| Tool | Purpose |
|---|---|
| `mesh_workspaces` | Registered workspaces, their recent sessions, available agent presets |
| `mesh_open` | New session in a workspace (optional agent preset and title) plus first message |
| `mesh_send` | Message an existing session, `queue` or `steer` |
| `mesh_read` | Status and compact feed of a session, incremental by `after_seq` |
| `mesh_wait` | Block until the session is idle, waits for the user, or times out; returns its answer |
| `mesh_cancel` | Stop the current turn |

## Rules (in code, no configuration)

- Only workspaces registered in DSH are reachable; arbitrary paths are refused.
- Subagent child sessions and the caller itself cannot be targeted.
- The agent chooses the agent preset, never the permission preset. New sessions
  get the profile default; sessions running with `danger-full-access` are refused.
- Approvals and questions stay in the target session; `mesh_read`/`mesh_wait`
  report `waiting_for_user`.
- Every delivered message starts with an `[agent-mesh] from session …` header so
  the receiving agent knows who wrote and how to answer.
- Chain depth is at most 2 (A → B → C); replies to a peer add no depth.
- At most 10 `mesh_open` per session per hour and 20 `mesh_send` per target per hour.
- No plugin state: depth and rate limits are derived from session logs.

## Install

`plugin_manager install_bundle` with this directory as the target.

## Test

```
node --test test/*.test.mjs
```
