'use strict';

const crypto = require('crypto');
const path = require('path');

const EVENT_TYPES = Object.freeze({
  AGENT_SEEN: 'AGENT_SEEN',
  TOOL_START: 'TOOL_START',
  TOOL_END: 'TOOL_END',
  ASSISTANT_OUTPUT: 'ASSISTANT_OUTPUT',
  WAITING: 'WAITING',
  SUBAGENT_SPAWN: 'SUBAGENT_SPAWN'
});

function safeJsonParse(line) {
  try {
    return JSON.parse(line);
  } catch (error) {
    return null;
  }
}

function pick(entry, paths) {
  for (const rawPath of paths) {
    const parts = rawPath.split('.');
    let cursor = entry;
    let found = true;
    for (const part of parts) {
      if (cursor && typeof cursor === 'object' && Object.prototype.hasOwnProperty.call(cursor, part)) {
        cursor = cursor[part];
      } else {
        found = false;
        break;
      }
    }
    if (found && cursor !== undefined && cursor !== null) {
      return cursor;
    }
  }
  return undefined;
}

function toMs(tsLike) {
  if (typeof tsLike === 'number' && Number.isFinite(tsLike)) {
    return tsLike < 1e12 ? Math.floor(tsLike * 1000) : Math.floor(tsLike);
  }
  if (typeof tsLike === 'string') {
    if (/^\d+$/.test(tsLike)) {
      const num = Number(tsLike);
      if (Number.isFinite(num)) {
        return num < 1e12 ? Math.floor(num * 1000) : Math.floor(num);
      }
    }
    const parsed = Date.parse(tsLike);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  return Date.now();
}

function stableFallbackId(filePath, sessionId, projectId) {
  const base = `${filePath}|${sessionId || ''}|${projectId || ''}`;
  const digest = crypto.createHash('sha1').update(base).digest('hex').slice(0, 10);
  return `agent-${digest}`;
}

function deriveContextFromPath(filePath, configuredRoot) {
  const normalized = path.resolve(filePath);
  const root = configuredRoot ? path.resolve(configuredRoot) : '';
  if (!root || !normalized.startsWith(root)) {
    return { projectId: null, sessionId: null };
  }

  const rel = path.relative(root, normalized);
  const parts = rel.split(path.sep).filter(Boolean);
  const projectId = parts.length > 0 ? parts[0] : null;
  const fileName = parts.length > 0 ? parts[parts.length - 1] : '';
  const sessionId = fileName.replace(/\.jsonl$/i, '') || null;
  return { projectId, sessionId };
}

function contentBlocks(entry) {
  const direct = pick(entry, ['content']);
  if (Array.isArray(direct)) {
    return direct;
  }

  const nested = pick(entry, ['message.content', 'delta.content']);
  if (Array.isArray(nested)) {
    return nested;
  }

  return [];
}

function hasAssistantOutput(entry, blocks) {
  const role = String(pick(entry, ['role', 'message.role', 'delta.role']) || '').toLowerCase();
  const type = String(pick(entry, ['type', 'event']) || '').toLowerCase();

  if (role === 'assistant') {
    return true;
  }

  if (type.includes('assistant') && (type.includes('message') || type.includes('delta') || type.includes('output'))) {
    return true;
  }

  if (typeof pick(entry, ['text', 'delta.text']) === 'string' && role !== 'user') {
    return true;
  }

  for (const block of blocks) {
    if (!block || typeof block !== 'object') {
      continue;
    }
    const blockType = String(block.type || '').toLowerCase();
    if (blockType === 'text' || blockType === 'output_text' || blockType === 'assistant_text') {
      return true;
    }
  }

  return false;
}

function explicitSpawnInfo(entry) {
  const eventName = String(pick(entry, ['event', 'type', 'name', 'action']) || '').toLowerCase();
  const isSpawnEvent = eventName.includes('spawn') && (eventName.includes('agent') || eventName.includes('sub'));
  if (!isSpawnEvent) {
    return null;
  }

  const parentId = pick(entry, [
    'parentId',
    'parent_id',
    'meta.parentId',
    'metadata.parent_id',
    'details.parentAgentId'
  ]);
  const childId = pick(entry, [
    'childAgentId',
    'child_agent_id',
    'spawnedAgentId',
    'spawned_agent_id',
    'agentId',
    'agent_id',
    'meta.childId',
    'details.agentId'
  ]);

  if (!childId && !parentId) {
    return null;
  }

  return {
    parentId: parentId ? String(parentId) : undefined,
    childId: childId ? String(childId) : undefined
  };
}

function normalizeEntry(entry, context) {
  const ts = toMs(
    pick(entry, ['ts', 'timestamp', 'time', 'created_at', 'createdAt', 'meta.ts', 'metadata.timestamp'])
  );

  const projectId = String(
    pick(entry, ['projectId', 'project_id', 'project', 'metadata.projectId', 'meta.project_id']) ||
      context.projectId ||
      'unknown-project'
  );

  const sessionId = String(
    pick(entry, ['sessionId', 'session_id', 'conversation_id', 'thread_id', 'metadata.sessionId']) ||
      context.sessionId ||
      path.basename(context.filePath, '.jsonl') ||
      'unknown-session'
  );

  const parentIdValue = pick(entry, [
    'parentId',
    'parent_id',
    'metadata.parentId',
    'meta.parent_id',
    'context.parentAgentId'
  ]);

  const explicitAgentId = pick(entry, [
    'agentId',
    'agent_id',
    'assistant_id',
    'metadata.agentId',
    'meta.agent_id',
    'source.agentId',
    'message.agent_id'
  ]);

  const parentId = parentIdValue ? String(parentIdValue) : undefined;
  const spawn = explicitSpawnInfo(entry);
  const fallbackAgentId =
    sessionId && sessionId !== 'unknown-session'
      ? `${sessionId}:main`
      : stableFallbackId(context.filePath, sessionId, projectId);
  const agentId = explicitAgentId
    ? String(explicitAgentId)
    : spawn && spawn.childId
      ? spawn.childId
      : fallbackAgentId;

  const baseMeta = {
    projectId,
    sessionId,
    parentId,
    filePath: context.filePath
  };

  const events = [];
  const seenEvent = {
    type: EVENT_TYPES.AGENT_SEEN,
    agentId: agentId || stableFallbackId(context.filePath, sessionId, projectId),
    ts,
    meta: baseMeta
  };
  events.push(seenEvent);

  const blocks = contentBlocks(entry);

  const toolUseBlocks = blocks.filter((block) => block && String(block.type || '').toLowerCase() === 'tool_use');
  const toolResultBlocks = blocks.filter((block) => block && String(block.type || '').toLowerCase() === 'tool_result');

  const rawType = String(pick(entry, ['type', 'event']) || '').toLowerCase();

  if (rawType === 'tool_use') {
    toolUseBlocks.push(entry);
  }
  if (rawType === 'tool_result') {
    toolResultBlocks.push(entry);
  }

  for (const block of toolUseBlocks) {
    events.push({
      type: EVENT_TYPES.TOOL_START,
      agentId,
      ts,
      meta: {
        ...baseMeta,
        toolName: String(block.name || pick(entry, ['tool', 'toolName', 'name']) || 'unknown_tool')
      }
    });
  }

  for (const block of toolResultBlocks) {
    events.push({
      type: EVENT_TYPES.TOOL_END,
      agentId,
      ts,
      meta: {
        ...baseMeta,
        toolName: String(block.name || pick(entry, ['tool', 'toolName', 'name']) || 'unknown_tool')
      }
    });
  }

  if (hasAssistantOutput(entry, blocks)) {
    events.push({
      type: EVENT_TYPES.ASSISTANT_OUTPUT,
      agentId,
      ts,
      meta: baseMeta
    });
  }

  const waitingHint = String(
    pick(entry, ['status', 'state', 'phase', 'meta.status', 'metadata.state', 'stop_reason']) || ''
  ).toLowerCase();
  if (
    waitingHint === 'waiting' ||
    waitingHint === 'awaiting_user' ||
    waitingHint === 'awaiting_input' ||
    waitingHint === 'paused' ||
    waitingHint === 'pause_turn'
  ) {
    events.push({
      type: EVENT_TYPES.WAITING,
      agentId,
      ts,
      meta: baseMeta
    });
  }

  if (spawn) {
    const childId = spawn.childId || agentId;
    events.push({
      type: EVENT_TYPES.SUBAGENT_SPAWN,
      agentId: childId,
      ts,
      meta: {
        ...baseMeta,
        parentId: spawn.parentId || parentId,
        childId,
        explicit: true
      }
    });
  }

  return events;
}

function normalizeLine(line, context) {
  const parsed = safeJsonParse(line);
  if (!parsed || typeof parsed !== 'object') {
    return [];
  }

  const pathContext = deriveContextFromPath(context.filePath, context.configuredRoot);
  const mergedContext = {
    ...context,
    ...pathContext
  };

  return normalizeEntry(parsed, mergedContext);
}

module.exports = {
  EVENT_TYPES,
  normalizeLine
};
