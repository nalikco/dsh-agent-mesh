// Agent Mesh host half: model-facing tools that let an agent open, message,
// observe, and stop ordinary sessions in other DSH workspaces.
//
// Access rules (no Config by design):
// - Only workspaces registered in DSH are reachable.
// - A target session must belong to a registered workspace, must not be a
//   subagent child, and must not be the caller itself.
// - The agent picks an agent preset, never a permission preset. A target whose
//   sandbox resolves to danger-full-access is refused.
// - Chains are bounded (MAX_DEPTH) and message rate is bounded per pair.
// All bookkeeping is derived from session logs; the plugin keeps no state.
import { randomUUID } from 'node:crypto';

export const MAX_DEPTH = 2;
export const MAX_SENDS_PER_HOUR = 20;
export const MAX_OPENS_PER_HOUR = 10;
export const MAX_MESSAGE_BYTES = 64 * 1024;
export const WAIT_DEFAULT_S = 300;
export const WAIT_MAX_S = 1800;
const HOUR_MS = 3600 * 1000;
const POLL_MS = 2000;
const SESSIONS_PER_WORKSPACE = 8;
const HEADER_RE = /^\[agent-mesh\] from session (\S+) .*?, depth (\d+)(, reply)?\./;

export class MeshError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'MeshError';
    this.code = code;
  }
}

const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const output = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]
};

const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}… [${text.length - max} more chars]` : text);
const textOf = content => (Array.isArray(content) ? content.filter(b => b?.type === 'text').map(b => b.text).join('\n') : '');
const deepFreeze = value => {
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
};

export function parseMeshHeader(text) {
  const m = HEADER_RE.exec(text ?? '');
  return m ? { from: m[1], depth: Number(m[2]), reply: m[3] !== undefined } : undefined;
}

export function meshHeader(caller, cwd, depth, reply = false) {
  return `[agent-mesh] from session ${caller} (workspace ${cwd ?? 'unknown'}), depth ${depth}${reply ? ', reply' : ''}. ` +
    `This message was sent by another agent, not by the user. To answer, call mesh_send with session_id "${caller}".`;
}

/**
 * Mesh position of one session, derived from its log. `depth` is the longest
 * delegation chain that reached it (0 for a session the user drives); replies
 * never add depth. `peers` are sessions that have messaged it, so a message
 * back to one of them is a reply.
 */
export function incomingMesh(events) {
  const peers = new Set();
  let depth = 0;
  for (const event of events) {
    if (event.type !== 'user/message') continue;
    const header = parseMeshHeader(textOf(event.data?.content));
    if (!header) continue;
    peers.add(header.from);
    if (!header.reply) depth = Math.max(depth, header.depth);
  }
  return { depth, peers };
}

/** Count this session's own recent calls of one tool, optionally for one target. */
export function recentCalls(events, toolName, now, target) {
  let count = 0;
  for (const event of events) {
    if (event.type !== 'tool/call' || event.data?.name !== toolName || now - event.time > HOUR_MS) continue;
    if (target !== undefined) {
      let args;
      try { args = JSON.parse(event.data.arguments || '{}'); } catch { continue; }
      if (args?.session_id !== target) continue;
    }
    count++;
  }
  return count;
}

/** Derive the waiting state of a session from its log and live agent. */
export function sessionState(events, live) {
  const asked = new Map();
  const openCalls = new Map();
  let lastStart = -1;
  let lastEnd = -1;
  let endReason;
  for (const event of events) {
    switch (event.type) {
      case 'approval/asked': asked.set(event.data.id, event.data); break;
      case 'approval/decided': asked.delete(event.data.id); break;
      case 'tool/call': openCalls.set(event.data.callId, event.data.name); break;
      case 'tool/result': openCalls.delete(event.data?.message?.toolCallId); break;
      case 'turn/start': lastStart = event.seq; break;
      case 'turn/end': lastEnd = event.seq; endReason = event.data?.reason?.kind; break;
      default: break;
    }
  }
  const queued = live ? live.inbox.nextTurn.length + live.inbox.nextStep.length : 0;
  const running = live?.status === 'running';
  const turnOpen = lastStart > lastEnd;
  let waitingFor;
  if (asked.size > 0) {
    const pending = [...asked.values()][0];
    waitingFor = { kind: 'approval', tool: pending.toolName, reason: pending.reason ?? null };
  } else if ([...openCalls.values()].includes('ask_user_question')) {
    waitingFor = { kind: 'user_question' };
  }
  const status = waitingFor ? 'waiting_for_user' : running || queued > 0 ? 'running' : 'idle';
  return {
    status,
    ...(waitingFor ? { waiting_for: waitingFor } : {}),
    live: live !== undefined,
    queued_messages: queued,
    turn_open: turnOpen,
    last_turn_end_reason: endReason ?? null,
    running_tools: running ? [...new Set(openCalls.values())] : []
  };
}

/** Compact, model-facing feed items for one event, or undefined to skip it. */
export function feedItem(event) {
  const { type, seq, data } = event;
  if (type === 'user/message') {
    if (event.surfaceOp !== 'append' && event.surfaceOp !== undefined) return undefined;
    const kind = data?.source?.kind;
    if (kind !== 'user' && kind !== 'agent-message') return undefined;
    const text = textOf(data.content);
    if (!text) return undefined;
    const header = parseMeshHeader(text);
    return { seq, kind: header ? 'mesh_message' : 'user', ...(header ? { from: header.from } : {}), text: clip(header ? text.split('\n\n').slice(1).join('\n\n') || text : text, 2000) };
  }
  if (type === 'assistant/message') {
    const content = data?.message?.content ?? [];
    const text = textOf(content);
    const calls = content.filter(b => b?.type === 'tool-call').map(b => `${b.name}(${clip(b.arguments ?? '', 160)})`);
    if (!text && calls.length === 0) return undefined;
    return { seq, kind: 'assistant', ...(text ? { text: clip(text, 4000) } : {}), ...(calls.length ? { tool_calls: calls } : {}) };
  }
  if (type === 'tool/result') {
    if (!data?.message?.isError && !data?.error) return undefined;
    return { seq, kind: 'tool_error', text: clip(data.error?.reason ?? textOf(data.message?.content) ?? '', 300) };
  }
  if (type === 'approval/asked') return { seq, kind: 'approval_asked', tool: data.toolName, text: clip(data.reason ?? '', 300) };
  if (type === 'approval/decided') return { seq, kind: 'approval_decided', outcome: data.outcome };
  if (type === 'turn/end') return { seq, kind: 'turn_end', reason: data?.reason?.kind };
  return undefined;
}

/** Text of the last assistant message of the last finished turn. */
export function lastAnswer(events) {
  let endIndex = -1;
  for (let i = events.length - 1; i >= 0; i--) if (events[i].type === 'turn/end') { endIndex = i; break; }
  if (endIndex < 0) return undefined;
  for (let i = endIndex; i >= 0; i--) {
    const event = events[i];
    if (event.type === 'turn/start') break;
    if (event.type === 'assistant/message') {
      const text = textOf(event.data?.message?.content);
      if (text) return { seq: event.seq, text: clip(text, 8000) };
    }
  }
  return undefined;
}

export function apply(ctx) {
  const { tools, agents, sessionController: controller, workspaceRegistry: registry, sessionQuery } = ctx;

  const caller = exec => {
    const agent = exec?.agent;
    if (!agent) throw new MeshError('Agent Mesh tools require a calling agent session', 'NO_CALLER');
    return agent;
  };

  const workspaceOf = async cwd => {
    if (!cwd) return undefined;
    try { return await registry.resolveByPath(cwd); } catch { return undefined; }
  };

  const listWorkspaces = () => registry.list();

  const resolveWorkspace = async ref => {
    const value = String(ref ?? '').trim();
    if (!value) throw new MeshError('workspace is required', 'BAD_WORKSPACE');
    const byId = registry.get(value);
    if (byId) return byId;
    const byTitle = listWorkspaces().filter(w => w.title === value);
    if (byTitle.length === 1) return byTitle[0];
    if (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)) {
      const byPath = await workspaceOf(value);
      if (byPath) return byPath;
    }
    const known = listWorkspaces().map(w => `${w.title} (${w.id}, ${w.path})`).join('; ');
    throw new MeshError(`"${value}" is not a workspace registered in DSH. Only registered workspaces are reachable; the user adds them in the DSH sidebar. Known: ${known || 'none'}`, 'WORKSPACE_NOT_REGISTERED');
  };

  const inspect = async (id, signal) => {
    try { return await controller.inspect(id, signal); } catch (error) {
      throw new MeshError(`session "${id}" not found: ${error?.message ?? error}`, 'SESSION_NOT_FOUND');
    }
  };

  /** Validate a target session and return its log and workspace. */
  const target = async (self, id, signal) => {
    const sessionId = String(id ?? '').trim();
    if (!sessionId) throw new MeshError('session_id is required', 'BAD_SESSION');
    if (sessionId === self.id) throw new MeshError('A session cannot address itself through Agent Mesh', 'SELF');
    const inspection = await inspect(sessionId, signal);
    const meta = inspection.meta;
    if (meta.origin === 'subagent') throw new MeshError(`session "${sessionId}" is a subagent child; Agent Mesh addresses only ordinary sessions`, 'SUBAGENT_SESSION');
    const workspace = listWorkspaces().find(w => w.sessionIds.includes(sessionId)) ?? await workspaceOf(meta.cwd);
    if (!workspace) throw new MeshError(`session "${sessionId}" does not belong to a workspace registered in DSH`, 'WORKSPACE_NOT_REGISTERED');
    return { sessionId, meta, events: inspection.events, workspace };
  };

  const sandboxMode = session => {
    try { return ctx.get('sandboxPolicy')?.resolve({ session }).mode; } catch { return undefined; }
  };

  const permissionName = session => {
    try { return ctx.get('permissionPresets')?.current(session); } catch { return undefined; }
  };

  const liveAgent = async sessionId => {
    const found = await controller.resolveAgent(sessionId);
    if ('error' in found) throw new MeshError(`session "${sessionId}" cannot receive messages: ${found.error.message}`, found.error.code ?? 'SESSION_UNAVAILABLE');
    return found.agent;
  };

  const assertNotFullAccess = (agent, sessionId) => {
    if (sandboxMode(agent.session) === 'danger-full-access') {
      throw new MeshError(`session "${sessionId}" runs with full access. Agent Mesh never drives full-access sessions; ask the user to switch that session to a workspace-write preset first`, 'FULL_ACCESS_REFUSED');
    }
  };

  const deliver = (self, agent, text, depth, mode, reply = false) => {
    const body = String(text ?? '');
    if (!body.trim()) throw new MeshError('message must contain non-whitespace text', 'EMPTY_MESSAGE');
    if (Buffer.byteLength(body, 'utf8') > MAX_MESSAGE_BYTES) throw new MeshError(`message exceeds ${MAX_MESSAGE_BYTES} bytes`, 'MESSAGE_TOO_LARGE');
    const message = deepFreeze({
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: `${meshHeader(self.id, self.session.header.cwd, depth, reply)}\n\n${body}` }],
      source: { kind: 'agent-message', form: 'relay', senderSessionId: self.id }
    });
    agents.withoutInitiator(() => (mode === 'steer' ? agent.steer(message) : agent.followup(message)));
    return message.id;
  };

  const workspaceView = w => ({ id: w.id, title: w.title, path: w.path });

  const run = fn => async (args, exec) => {
    exec?.signal?.throwIfAborted?.();
    try { return await fn(args ?? {}, exec); } catch (error) {
      if (error instanceof MeshError) throw new Error(`${error.code}: ${error.message}`);
      throw error;
    }
  };

  // ---------------------------------------------------------------- tools

  ctx.effect(() => tools.register({
    name: 'mesh_workspaces',
    description: 'List the workspaces registered in DSH that Agent Mesh can reach (one per repository), their most recent sessions, and the agent presets available for mesh_open. Call this first to find the workspace of another repository and to reuse an existing session instead of opening a new one.',
    parameters: object({}),
    output,
    isConcurrencySafe: () => true,
    execute: run(async (_args, exec) => {
      const self = caller(exec);
      const archived = new Set(registry.archivedSessionIds ?? []);
      const workspaces = [];
      for (const w of listWorkspaces()) {
        const ids = w.sessionIds.filter(id => !archived.has(id)).slice(0, SESSIONS_PER_WORKSPACE * 2);
        let sessions = [];
        if (ids.length > 0 && sessionQuery?.readTitleSnapshots) {
          const results = await sessionQuery.readTitleSnapshots(ids, exec.signal);
          sessions = results.filter(r => r.status === 'fulfilled' && r.value.session.origin !== 'subagent').map(r => ({
            session_id: r.sessionId,
            title: r.value.title?.title ?? null,
            created_at: new Date(r.value.session.createdAt).toISOString(),
            status: agents.get(r.sessionId)?.status ?? 'idle',
            ...(r.sessionId === self.id ? { is_you: true } : {})
          }));
          sessions.sort((a, b) => b.created_at.localeCompare(a.created_at));
          sessions = sessions.slice(0, SESSIONS_PER_WORKSPACE);
        }
        let status = 'ok';
        try { status = await w.status(); } catch { status = 'unknown'; }
        workspaces.push({ ...workspaceView(w), directory: status, ...(w.path === self.session.header.cwd ? { is_yours: true } : {}), recent_sessions: sessions });
      }
      let presets = [];
      const registryPresets = ctx.get('agentPresets');
      if (registryPresets) {
        const roster = await registryPresets.remoteExportList();
        presets = roster.presets.filter(p => !p.broken).map(p => ({ id: p.id, name: p.name ?? p.id, description: p.description ?? null, default: p.isDefault }));
      }
      return { workspaces, agent_presets: presets };
    })
  }));

  ctx.effect(() => tools.register({
    name: 'mesh_open',
    description: 'Open a new ordinary session in another DSH workspace and send it the first message. The new agent works in that repository with the default permission preset (sandboxed to its own workspace, approvals shown to the user there); it sees your session id and can answer with mesh_send. Use mesh_wait to block until it finishes, mesh_read to watch progress. Write the prompt as a complete, self-contained task: the other agent does not see this conversation.',
    parameters: object({
      workspace: { type: 'string', description: 'Workspace id, exact title, or absolute path from mesh_workspaces. Must be registered in DSH.' },
      prompt: { type: 'string', description: 'Complete, self-contained first message for the new agent.' },
      agent_preset: { type: 'string', description: 'Agent preset id from mesh_workspaces (decides which plugins and MCP servers the agent gets). Omit for the default preset.' },
      title: { type: 'string', description: 'Optional session title shown in the DSH sidebar.' }
    }, ['workspace', 'prompt']),
    output,
    execute: run(async (args, exec) => {
      const self = caller(exec);
      const ownEvents = self.session.snapshotEvents();
      const depth = incomingMesh(ownEvents).depth + 1;
      if (depth > MAX_DEPTH) throw new MeshError(`mesh chain depth would reach ${depth} (max ${MAX_DEPTH}). This session was itself started by another agent; report back to it instead of opening further sessions`, 'DEPTH_LIMIT');
      if (recentCalls(ownEvents, 'mesh_open', Date.now()) > MAX_OPENS_PER_HOUR) throw new MeshError(`more than ${MAX_OPENS_PER_HOUR} mesh_open calls in the last hour; reuse existing sessions with mesh_send`, 'RATE_LIMIT');
      const workspace = await resolveWorkspace(args.workspace);
      if ((await workspace.status()) !== 'ok') throw new MeshError(`workspace directory ${workspace.path} is missing`, 'WORKSPACE_MISSING');
      const created = await agents.withoutInitiator(() => controller.create({
        workspaceId: workspace.id,
        ...(args.agent_preset ? { agentPreset: String(args.agent_preset) } : {})
      }));
      const sessionId = created.sessionId;
      const agent = await liveAgent(sessionId);
      if (sandboxMode(agent.session) === 'danger-full-access') {
        await registry.archiveSession(sessionId, { stopActivity: true }).catch(() => {});
        throw new MeshError('the default permission preset of this profile grants full access, so Agent Mesh refused to start an agent with it (the blank session was archived). Ask the user to make a workspace-write preset the default', 'FULL_ACCESS_REFUSED');
      }
      if (args.title) await controller.rename({ sessionId, title: String(args.title) }).catch(() => {});
      deliver(self, agent, args.prompt, depth, 'queue');
      return {
        session_id: sessionId,
        workspace: workspaceView(workspace),
        agent_preset: created.agentPreset ?? null,
        permission_preset: permissionName(agent.session) ?? null,
        depth,
        next: 'Call mesh_wait with this session_id to get the answer, or mesh_read to watch progress.'
      };
    })
  }));

  ctx.effect(() => tools.register({
    name: 'mesh_send',
    description: 'Send a message to an existing session in a DSH workspace (one you opened, one that messaged you, or one listed by mesh_workspaces). mode "queue" delivers it as the next turn; "steer" injects it into the running turn at the next step boundary. An idle session wakes up. Returns immediately; use mesh_wait for the reply.',
    parameters: object({
      session_id: { type: 'string', description: 'Target session id.' },
      message: { type: 'string', description: 'Self-contained message text.' },
      mode: { type: 'string', enum: ['queue', 'steer'], description: 'queue (default) or steer.' }
    }, ['session_id', 'message']),
    output,
    execute: run(async (args, exec) => {
      const self = caller(exec);
      const ownEvents = self.session.snapshotEvents();
      const t = await target(self, args.session_id, exec.signal);
      const incoming = incomingMesh(ownEvents);
      // Answering a session that wrote to us is a reply and adds no depth; anything else opens a new hop.
      const reply = incoming.peers.has(t.sessionId);
      const depth = reply ? incoming.depth : incoming.depth + 1;
      if (!reply && depth > MAX_DEPTH) throw new MeshError(`mesh chain depth would reach ${depth} (max ${MAX_DEPTH}); reply to the session that started you instead`, 'DEPTH_LIMIT');
      if (recentCalls(ownEvents, 'mesh_send', Date.now(), t.sessionId) > MAX_SENDS_PER_HOUR) throw new MeshError(`more than ${MAX_SENDS_PER_HOUR} messages to this session in the last hour; stop and report to the user`, 'RATE_LIMIT');
      const agent = await liveAgent(t.sessionId);
      assertNotFullAccess(agent, t.sessionId);
      const mode = args.mode === 'steer' ? 'steer' : 'queue';
      deliver(self, agent, args.message, depth, mode, reply);
      return { sent: true, session_id: t.sessionId, workspace: workspaceView(t.workspace), mode, reply, depth, status: agent.status };
    })
  }));

  ctx.effect(() => tools.register({
    name: 'mesh_read',
    description: 'Read the progress of a session in a DSH workspace without waking it: its status (running, idle, waiting_for_user when an approval or question is pending there) and a compact feed of user/mesh messages, assistant text, tool calls, tool errors, approvals and turn ends. Pass after_seq = next_seq from the previous call to read only new items.',
    parameters: object({
      session_id: { type: 'string', description: 'Target session id.' },
      after_seq: { type: 'integer', description: 'Return items after this event seq. Omit to get the latest items.' },
      limit: { type: 'integer', description: 'Max feed items, 1-100. Default 30.' }
    }, ['session_id']),
    output,
    isConcurrencySafe: () => true,
    execute: run(async (args, exec) => {
      const self = caller(exec);
      const t = await target(self, args.session_id, exec.signal);
      const limit = Number.isInteger(args.limit) ? Math.min(Math.max(args.limit, 1), 100) : 30;
      const items = [];
      for (const event of t.events) {
        if (args.after_seq !== undefined && event.seq <= args.after_seq) continue;
        const item = feedItem(event);
        if (item) items.push(item);
      }
      const page = args.after_seq === undefined ? items.slice(-limit) : items.slice(0, limit);
      const lastSeq = t.events.at(-1)?.seq ?? -1;
      return {
        session_id: t.sessionId,
        workspace: workspaceView(t.workspace),
        ...sessionState(t.events, agents.get(t.sessionId)),
        items: page,
        has_more: args.after_seq !== undefined && items.length > page.length,
        next_seq: args.after_seq !== undefined && items.length > page.length ? page.at(-1).seq : lastSeq
      };
    })
  }));

  ctx.effect(() => tools.register({
    name: 'mesh_wait',
    description: 'Block until a session in a DSH workspace finishes its work (idle with an empty queue), needs the user (pending approval or question there), or the timeout passes. Returns the status and the final assistant answer of its last turn. Call right after mesh_open or mesh_send.',
    parameters: object({
      session_id: { type: 'string', description: 'Target session id.' },
      timeout_s: { type: 'integer', description: `Seconds to wait, 5-${WAIT_MAX_S}. Default ${WAIT_DEFAULT_S}.` }
    }, ['session_id']),
    output,
    timeoutMs: (WAIT_MAX_S + 60) * 1000,
    isConcurrencySafe: () => true,
    execute: run(async (args, exec) => {
      const self = caller(exec);
      const t = await target(self, args.session_id, exec.signal);
      const timeoutS = Number.isInteger(args.timeout_s) ? Math.min(Math.max(args.timeout_s, 5), WAIT_MAX_S) : WAIT_DEFAULT_S;
      const deadline = Date.now() + timeoutS * 1000;
      const startSeq = t.events.at(-1)?.seq ?? -1;

      const snapshot = async () => {
        const inspection = await inspect(t.sessionId, exec.signal);
        return { events: inspection.events, state: sessionState(inspection.events, agents.get(t.sessionId)) };
      };
      const settled = s => s.state.status !== 'running';

      let current = await snapshot();
      if (!settled(current)) {
        current = await new Promise((resolvePromise, reject) => {
          let done = false;
          let checking = false;
          const disposers = [];
          const finish = (value, error) => {
            if (done) return;
            done = true;
            for (const d of disposers) d();
            if (error) reject(error); else resolvePromise(value);
          };
          const check = async () => {
            if (done || checking) return;
            checking = true;
            try {
              const s = await snapshot();
              if (settled(s) || Date.now() >= deadline) finish(s);
            } catch (error) { finish(undefined, error); } finally { checking = false; }
          };
          const timer = setInterval(check, POLL_MS);
          disposers.push(() => clearInterval(timer));
          const onAbort = () => finish(undefined, new Error('mesh_wait aborted'));
          exec.signal.addEventListener('abort', onAbort, { once: true });
          disposers.push(() => exec.signal.removeEventListener('abort', onAbort));
          disposers.push(ctx.on('agent/status', ({ agent, status }) => { if (agent.id === t.sessionId && status === 'idle') void check(); }));
          disposers.push(ctx.on('session/event', (session, event) => {
            if (session.id === t.sessionId && (event.type === 'turn/end' || event.type === 'approval/asked')) void check();
          }));
        });
      }
      const answer = lastAnswer(current.events);
      const timedOut = current.state.status === 'running';
      return {
        session_id: t.sessionId,
        workspace: workspaceView(t.workspace),
        timed_out: timedOut,
        ...current.state,
        answer: answer && answer.seq > startSeq ? answer.text : null,
        ...(answer && answer.seq <= startSeq ? { previous_answer: answer.text } : {}),
        next_seq: current.events.at(-1)?.seq ?? -1,
        ...(current.state.status === 'waiting_for_user' ? { hint: 'The other session is waiting for the user. Tell the user to open that session in DSH and answer there, then call mesh_wait again.' } : {}),
        ...(timedOut ? { hint: 'Still running. Call mesh_wait again or mesh_read to see progress.' } : {})
      };
    })
  }));

  ctx.effect(() => tools.register({
    name: 'mesh_cancel',
    description: 'Stop the current turn of a session in a DSH workspace. Its queued messages stay pending.',
    parameters: object({
      session_id: { type: 'string', description: 'Target session id.' }
    }, ['session_id']),
    output,
    execute: run(async (args, exec) => {
      const self = caller(exec);
      const t = await target(self, args.session_id, exec.signal);
      const live = agents.get(t.sessionId);
      if (!live || live.status !== 'running') return { cancelled: false, session_id: t.sessionId, reason: 'not running' };
      controller.cancel({ sessionId: t.sessionId });
      return { cancelled: true, session_id: t.sessionId };
    })
  }));
}
