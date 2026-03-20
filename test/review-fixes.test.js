'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { StringDecoder } = require('string_decoder');

const { EVENT_TYPES, normalizeLine } = require('../parser');
const { AgentState } = require('../state');
const { TranscriptWatcher } = require('../watcher');

test('CLI supports --help without starting the server', () => {
  const cliPath = path.join(__dirname, '..', 'cli.js');
  const result = spawnSync(process.execPath, [cliPath, '--help'], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    timeout: 5000
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage:/);
});

test('explicit spawn events do not create a ghost agent id', () => {
  const events = normalizeLine(
    JSON.stringify({
      type: 'subagent_spawn',
      projectId: 'project-a',
      sessionId: 'session-a',
      parentId: 'parent-1',
      childAgentId: 'child-1'
    }),
    {
      filePath: '/tmp/project-a/session-a.jsonl',
      configuredRoot: '/tmp'
    }
  );

  assert.equal(events[0].type, EVENT_TYPES.AGENT_SEEN);
  assert.equal(events[0].agentId, 'child-1');
  assert.equal(events[1].type, EVENT_TYPES.SUBAGENT_SPAWN);
  assert.equal(events[1].agentId, 'child-1');
  assert.equal(events[1].meta.parentId, 'parent-1');
});

test('state creates a placeholder parent without self-linking on spawn', () => {
  const state = new AgentState();

  state.applyEvent({
    type: EVENT_TYPES.SUBAGENT_SPAWN,
    agentId: 'child-1',
    ts: 1,
    meta: {
      parentId: 'parent-1',
      projectId: 'project-a',
      sessionId: 'session-a'
    }
  });

  const parent = state.agents.get('parent-1');
  const child = state.agents.get('child-1');

  assert.ok(parent);
  assert.ok(child);
  assert.equal(parent.parentId, undefined);
  assert.deepEqual(Array.from(parent.childrenIds), ['child-1']);
  assert.equal(child.parentId, 'parent-1');
});

test('seen counter only increments for AGENT_SEEN events', () => {
  const state = new AgentState();

  state.applyEvent({
    type: EVENT_TYPES.TOOL_START,
    agentId: 'agent-1',
    ts: 1,
    meta: {}
  });
  state.applyEvent({
    type: EVENT_TYPES.AGENT_SEEN,
    agentId: 'agent-1',
    ts: 2,
    meta: {}
  });

  assert.equal(state.agents.get('agent-1').counters.seen, 1);
});

test('watcher preserves multibyte utf8 across incremental reads', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'poke-agents-'));
  const filePath = path.join(tempRoot, 'session.jsonl');
  fs.writeFileSync(filePath, '');

  const watcher = new TranscriptWatcher({ rootPath: tempRoot });
  const events = [];
  watcher.on('event', (event) => events.push(event));

  const state = {
    position: 0,
    leftover: '',
    decoder: new StringDecoder('utf8'),
    reading: false,
    pending: false
  };
  watcher.fileStates.set(filePath, state);

  const prefix = Buffer.from('{"role":"assistant","text":"');
  const splitChar = Buffer.from('한', 'utf8');
  const suffix = Buffer.from('"}\n');

  fs.appendFileSync(filePath, Buffer.concat([prefix, splitChar.subarray(0, 1)]));
  await watcher.readNewBytes(filePath, state, false);
  assert.equal(events.length, 0);

  fs.appendFileSync(filePath, Buffer.concat([splitChar.subarray(1), suffix]));
  await watcher.readNewBytes(filePath, state, false);

  assert.equal(events.length, 2);
  assert.equal(events[0].type, EVENT_TYPES.AGENT_SEEN);
  assert.equal(events[1].type, EVENT_TYPES.ASSISTANT_OUTPUT);
});
