'use strict';

const EventEmitter = require('events');
const { EVENT_TYPES } = require('./parser');

const STATUS = Object.freeze({
  IDLE: 'Idle',
  THINKING: 'Thinking',
  TOOL: 'Tool-Running',
  OUTPUT: 'Outputting',
  WAITING: 'Waiting'
});

const DEFAULT_RING_SIZE = 300;

class AgentState extends EventEmitter {
  constructor(options = {}) {
    super();
    this.activeTimeoutMs = (options.activeTimeoutSec || 60) * 1000;
    this.staleTimeoutMs = (options.staleTimeoutSec || 300) * 1000;
    this.ringSize = options.ringSize || DEFAULT_RING_SIZE;

    this.agents = new Map();
    this.recentEvents = [];
    this.lastUpdate = 0;
  }

  upsertAgent(agentId, ts, meta = {}) {
    let created = false;
    let agent = this.agents.get(agentId);

    if (!agent) {
      created = true;
      agent = {
        agentId,
        name: agentId,
        projectId: meta.projectId || 'unknown-project',
        sessionId: meta.sessionId || 'unknown-session',
        parentId: meta.parentId,
        childrenIds: new Set(),
        status: STATUS.THINKING,
        activity: 'Seen',
        lastTool: null,
        lastSeen: ts,
        createdAt: ts,
        counters: {
          seen: 0,
          toolStarts: 0,
          toolEnds: 0,
          outputs: 0,
          waits: 0,
          spawns: 0
        }
      };
      this.agents.set(agentId, agent);
    }

    agent.lastSeen = Math.max(agent.lastSeen || 0, ts);
    if (meta.projectId) {
      agent.projectId = meta.projectId;
    }
    if (meta.sessionId) {
      agent.sessionId = meta.sessionId;
    }
    if (meta.parentId) {
      agent.parentId = meta.parentId;
    }

    if (agent.parentId) {
      const parent = this.agents.get(agent.parentId);
      if (parent) {
        parent.childrenIds.add(agent.agentId);
      }
    }

    return { agent, created };
  }

  pushRecentEvent(event) {
    this.recentEvents.push(event);
    if (this.recentEvents.length > this.ringSize) {
      this.recentEvents.splice(0, this.recentEvents.length - this.ringSize);
    }
  }

  applyEvent(event) {
    if (!event || !event.agentId || !event.type) {
      return;
    }

    const ts = typeof event.ts === 'number' ? event.ts : Date.now();
    const meta = event.meta || {};
    const { agent, created } = this.upsertAgent(event.agentId, ts, meta);
    const previousStatus = agent.status;

    agent.counters.seen += 1;

    if (created && agent.parentId) {
      const parent = this.agents.get(agent.parentId);
      if (parent) {
        parent.childrenIds.add(agent.agentId);
      }
      const inferredSpawn = {
        type: EVENT_TYPES.SUBAGENT_SPAWN,
        agentId: agent.agentId,
        ts,
        meta: {
          ...meta,
          parentId: agent.parentId,
          inferred: true
        }
      };
      this.pushRecentEvent(inferredSpawn);
    }

    switch (event.type) {
      case EVENT_TYPES.AGENT_SEEN:
        if (agent.status === STATUS.IDLE || !agent.status) {
          agent.status = STATUS.THINKING;
          agent.activity = 'Active';
        }
        break;
      case EVENT_TYPES.TOOL_START:
        agent.status = STATUS.TOOL;
        agent.activity = 'Running Tool';
        agent.lastTool = meta.toolName || agent.lastTool;
        agent.counters.toolStarts += 1;
        break;
      case EVENT_TYPES.TOOL_END:
        agent.status = STATUS.THINKING;
        agent.activity = 'Tool Finished';
        agent.lastTool = meta.toolName || agent.lastTool;
        agent.counters.toolEnds += 1;
        break;
      case EVENT_TYPES.ASSISTANT_OUTPUT:
        agent.status = STATUS.OUTPUT;
        agent.activity = 'Outputting';
        agent.counters.outputs += 1;
        break;
      case EVENT_TYPES.WAITING:
        agent.status = STATUS.WAITING;
        agent.activity = 'Waiting';
        agent.counters.waits += 1;
        break;
      case EVENT_TYPES.SUBAGENT_SPAWN: {
        const parentId = meta.parentId;
        if (parentId) {
          const parent = this.agents.get(parentId) || this.upsertAgent(parentId, ts, meta).agent;
          parent.childrenIds.add(agent.agentId);
          agent.parentId = parentId;
        }
        agent.status = STATUS.THINKING;
        agent.activity = 'Spawned';
        agent.counters.spawns += 1;
        break;
      }
      default:
        break;
    }

    this.pushRecentEvent(event);
    this.lastUpdate = Date.now();

    if (agent.status !== previousStatus || created || event.type !== EVENT_TYPES.AGENT_SEEN) {
      this.emit('update', this.snapshot());
    }
  }

  tick(now = Date.now()) {
    let changed = false;

    for (const [agentId, agent] of this.agents.entries()) {
      const age = now - agent.lastSeen;

      if (age >= this.staleTimeoutMs) {
        this.agents.delete(agentId);
        if (agent.parentId) {
          const parent = this.agents.get(agent.parentId);
          if (parent) {
            parent.childrenIds.delete(agentId);
          }
        }
        changed = true;
        continue;
      }

      if (age >= this.activeTimeoutMs && agent.status !== STATUS.IDLE) {
        agent.status = STATUS.IDLE;
        agent.activity = 'Idle';
        changed = true;
      }
    }

    if (changed) {
      this.lastUpdate = now;
      this.emit('update', this.snapshot());
    }
  }

  snapshot() {
    const now = Date.now();
    const agents = Array.from(this.agents.values())
      .map((agent) => ({
        agentId: agent.agentId,
        name: agent.name,
        projectId: agent.projectId,
        sessionId: agent.sessionId,
        parentId: agent.parentId,
        childrenIds: Array.from(agent.childrenIds),
        status: agent.status,
        activity: agent.activity,
        lastTool: agent.lastTool,
        lastSeen: agent.lastSeen,
        isActive: now - agent.lastSeen < this.activeTimeoutMs,
        counters: { ...agent.counters }
      }))
      .sort((a, b) => b.lastSeen - a.lastSeen);

    return {
      now,
      lastUpdate: this.lastUpdate || now,
      activeTimeoutSec: Math.floor(this.activeTimeoutMs / 1000),
      staleTimeoutSec: Math.floor(this.staleTimeoutMs / 1000),
      activeAgentCount: agents.filter((agent) => agent.isActive).length,
      agents,
      recentEvents: this.recentEvents.slice(-80)
    };
  }
}

module.exports = {
  AgentState,
  STATUS
};
