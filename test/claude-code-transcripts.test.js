'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { StringDecoder } = require('string_decoder');

const { EVENT_TYPES, normalizeLine } = require('../parser');
const { AgentState } = require('../state');
const { TranscriptWatcher } = require('../watcher');

function contextFor(filePath, configuredRoot) {
  return { filePath, configuredRoot };
}

test('Claude Code assistant tool-use messages are normalized from transcript paths', () => {
  const events = normalizeLine(
    JSON.stringify({
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', name: 'Read' }
        ]
      }
    }),
    contextFor('/tmp/claude/projects/demo-project/session-123.jsonl', '/tmp/claude/projects')
  );

  assert.deepEqual(
    events.map((event) => event.type),
    [EVENT_TYPES.AGENT_SEEN, EVENT_TYPES.TOOL_START, EVENT_TYPES.ASSISTANT_OUTPUT]
  );
  assert.equal(events[0].agentId, 'session-123:main');
  assert.equal(events[0].meta.projectId, 'demo-project');
  assert.equal(events[0].meta.sessionId, 'session-123');
  assert.equal(events[1].meta.toolName, 'Read');
});

test('Claude Code tool results and pause_turn entries normalize correctly', () => {
  const transcriptContext = contextFor('/tmp/claude/projects/demo-project/session-123.jsonl', '/tmp/claude/projects');

  const toolEvents = normalizeLine(
    JSON.stringify({
      type: 'tool_result',
      name: 'Read',
      agent_id: 'main-agent'
    }),
    transcriptContext
  );
  assert.deepEqual(toolEvents.map((event) => event.type), [EVENT_TYPES.AGENT_SEEN, EVENT_TYPES.TOOL_END]);
  assert.equal(toolEvents[1].meta.toolName, 'Read');

  const waitEvents = normalizeLine(
    JSON.stringify({
      agent_id: 'main-agent',
      stop_reason: 'pause_turn'
    }),
    transcriptContext
  );
  assert.deepEqual(waitEvents.map((event) => event.type), [EVENT_TYPES.AGENT_SEEN, EVENT_TYPES.WAITING]);
});

test('Claude Code subagent spawn entries preserve child and parent ids', () => {
  const events = normalizeLine(
    JSON.stringify({
      event: 'subagent_spawn',
      parent_id: 'session-123:main',
      child_agent_id: 'worker-1'
    }),
    contextFor('/tmp/claude/projects/demo-project/session-123.jsonl', '/tmp/claude/projects')
  );

  assert.deepEqual(events.map((event) => event.type), [EVENT_TYPES.AGENT_SEEN, EVENT_TYPES.SUBAGENT_SPAWN]);
  assert.equal(events[0].agentId, 'worker-1');
  assert.equal(events[1].agentId, 'worker-1');
  assert.equal(events[1].meta.parentId, 'session-123:main');
});

test('watcher and state process a Claude Code style transcript stream end to end', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poke-agents-claude-'));
  const projectDir = path.join(rootDir, 'demo-project');
  const transcriptPath = path.join(projectDir, 'session-123.jsonl');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(transcriptPath, '');

  const watcher = new TranscriptWatcher({ rootPath: rootDir });
  const state = new AgentState();
  watcher.on('event', (event) => state.applyEvent(event));

  const fileState = {
    position: 0,
    leftover: '',
    decoder: new StringDecoder('utf8'),
    reading: false,
    pending: false
  };
  watcher.fileStates.set(transcriptPath, fileState);

  const lines = [
    {
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', name: 'Read' }
        ]
      }
    },
    {
      type: 'tool_result',
      name: 'Read',
      agent_id: 'session-123:main'
    },
    {
      event: 'subagent_spawn',
      parent_id: 'session-123:main',
      child_agent_id: 'worker-1'
    },
    {
      agent_id: 'worker-1',
      stop_reason: 'pause_turn'
    }
  ];

  fs.appendFileSync(transcriptPath, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
  await watcher.readNewBytes(transcriptPath, fileState, false);

  const mainAgent = state.agents.get('session-123:main');
  const childAgent = state.agents.get('worker-1');

  assert.ok(mainAgent);
  assert.ok(childAgent);
  assert.equal(mainAgent.projectId, 'demo-project');
  assert.equal(mainAgent.sessionId, 'session-123');
  assert.equal(mainAgent.counters.toolStarts, 1);
  assert.equal(mainAgent.counters.toolEnds, 1);
  assert.equal(mainAgent.lastTool, 'Read');
  assert.equal(childAgent.parentId, 'session-123:main');
  assert.equal(childAgent.projectId, 'demo-project');
  assert.equal(childAgent.sessionId, 'session-123');
  assert.equal(childAgent.status, 'Waiting');
  assert.equal(childAgent.counters.waits, 1);
});
