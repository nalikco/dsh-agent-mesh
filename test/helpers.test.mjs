import { test } from 'node:test';
import assert from 'node:assert/strict';
import { meshHeader, parseMeshHeader, incomingMesh, recentCalls, sessionState, lastAnswer, feedItem } from '../host.mjs';

const user = (seq, text, kind = 'agent-message') => ({ type: 'user/message', seq, time: 0, surfaceOp: 'append', data: { role: 'user', source: { kind }, content: [{ type: 'text', text }] } });

test('header round-trips and cannot be spoofed by body text', () => {
  const h = meshHeader('session-a', '/repo/a', 1);
  assert.deepEqual(parseMeshHeader(`${h}\n\nhello`), { from: 'session-a', depth: 1, reply: false });
  assert.equal(parseMeshHeader(`hi\n${h}`), undefined);
  assert.equal(parseMeshHeader(meshHeader('session-b', '/x, depth 9', 2, true)).depth, 2);
});

test('depth ignores replies, peers include repliers', () => {
  const events = [user(1, meshHeader('a', '/a', 1)), user(2, meshHeader('c', '/c', 2, true))];
  const m = incomingMesh(events);
  assert.equal(m.depth, 1);
  assert.ok(m.peers.has('a') && m.peers.has('c'));
  assert.equal(incomingMesh([user(1, 'plain', 'user')]).depth, 0);
});

test('recentCalls filters by tool, window and target', () => {
  const now = 10 * 3600 * 1000;
  const call = (time, name, sid) => ({ type: 'tool/call', seq: 0, time, data: { name, arguments: JSON.stringify({ session_id: sid }) } });
  const events = [call(now - 10, 'mesh_send', 'x'), call(now - 10, 'mesh_send', 'y'), call(now - 2 * 3600 * 1000, 'mesh_send', 'x'), call(now, 'mesh_open')];
  assert.equal(recentCalls(events, 'mesh_send', now, 'x'), 1);
  assert.equal(recentCalls(events, 'mesh_send', now), 2);
});

test('sessionState reports pending approval and idle', () => {
  const asked = { type: 'approval/asked', seq: 3, data: { id: 'r1', toolName: 'bash', reason: 'rm' } };
  const s = sessionState([asked], { status: 'running', inbox: { nextTurn: [], nextStep: [] } });
  assert.equal(s.status, 'waiting_for_user');
  assert.equal(s.waiting_for.tool, 'bash');
  const idle = sessionState([asked, { type: 'approval/decided', seq: 4, data: { id: 'r1', outcome: 'denied' } }], undefined);
  assert.equal(idle.status, 'idle');
});

test('lastAnswer takes the final assistant text of the last finished turn', () => {
  const a = (seq, text) => ({ type: 'assistant/message', seq, data: { message: { content: [{ type: 'text', text }] } } });
  const events = [{ type: 'turn/start', seq: 0 }, a(1, 'first'), a(2, 'final'), { type: 'turn/end', seq: 3, data: { reason: { kind: 'completed' } } }];
  assert.deepEqual(lastAnswer(events), { seq: 2, text: 'final' });
  assert.equal(lastAnswer(events.slice(0, 3)), undefined);
});

test('feedItem strips mesh header and skips noise', () => {
  const item = feedItem(user(5, `${meshHeader('a', '/a', 1)}\n\ndo it`));
  assert.equal(item.kind, 'mesh_message');
  assert.equal(item.text, 'do it');
  assert.equal(feedItem({ type: 'step/start', seq: 1, data: {} }), undefined);
});
