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
- Callers: only ordinary sessions (no subagents or teammates). `mesh_open`,
  `mesh_send` and `mesh_cancel` also require the caller to run `workspace-write`;
  `mesh_workspaces`, `mesh_read` and `mesh_wait` are observation-only.
- Targets: ordinary, non-archived sessions of registered workspaces, never the
  caller itself, and only while their sandbox is exactly `workspace-write`.
  A pre-step guard re-checks that when a mesh message is about to run, so a
  session switched to full access after the message was queued does not run it.
- The agent chooses the agent preset, never the permission preset. New sessions
  get the profile default; if that is not `workspace-write` the blank session
  is archived and the call fails.
- `steer`, `mesh_cancel`, tool arguments and user-typed messages in `mesh_read`
  are available only for sessions the caller opened or exchanged messages with.
  All returned text is marked as untrusted data.
- Approvals and questions stay in the target session; `mesh_read`/`mesh_wait`
  report `waiting_for_user`.
- Every delivered message starts with an `[agent-mesh] from session …` header and
  carries an `agent-message` relay source. Only headers whose source matches are
  trusted, so a user-typed copy cannot fake depth or a reply.
- Chain depth is at most 2 (A → B → C). Replies to a peer add no depth; at most
  8 replies in a row per pair. A message the user types resets the depth.
- `mesh_wait` refuses when the target is itself waiting on the caller.
- Per caller per hour: 10 `mesh_open`, 20 `mesh_send` per target, 60 in total,
  10 `mesh_cancel`.
- No plugin state: everything is derived from session logs.

## Install

`plugin_manager install_bundle` with this directory as the target.

## Test

```
node --test test/*.test.mjs
```
