#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const { EVENT_TYPES } = require('./parser');
const { AgentState } = require('./state');
const { TranscriptWatcher } = require('./watcher');
const { DashboardServer } = require('./server');

const DEFAULTS = {
  port: 8787,
  host: '127.0.0.1',
  claudeProjectsPath: path.join(os.homedir(), '.claude', 'projects'),
  activeTimeoutSec: 60,
  staleTimeoutSec: 300,
  enablePokeapiSprites: false
};

function parseBoolean(rawValue, fallback) {
  if (rawValue === undefined || rawValue === null) {
    return fallback;
  }
  const value = String(rawValue).trim().toLowerCase();
  if (value === '1' || value === 'true' || value === 'yes' || value === 'on') {
    return true;
  }
  if (value === '0' || value === 'false' || value === 'no' || value === 'off') {
    return false;
  }
  return fallback;
}

function parseNumber(rawValue, fallback) {
  if (rawValue === undefined || rawValue === null || rawValue === '') {
    return fallback;
  }
  const parsed = Number(rawValue);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseArgv(argv) {
  const out = { _: [] };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      out._.push(token);
      continue;
    }

    if (token === '--pokeapi') {
      out.enablePokeapiSprites = true;
      continue;
    }
    if (token === '--no-pokeapi') {
      out.enablePokeapiSprites = false;
      continue;
    }

    const eqIndex = token.indexOf('=');
    let key;
    let value;

    if (eqIndex >= 0) {
      key = token.slice(2, eqIndex);
      value = token.slice(eqIndex + 1);
    } else {
      key = token.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        value = next;
        i += 1;
      } else {
        value = 'true';
      }
    }

    out[key] = value;
  }

  return out;
}

function loadConfigFile(filePath) {
  const resolved = path.resolve(filePath || path.join(process.cwd(), 'config.json'));
  if (!fs.existsSync(resolved)) {
    return {};
  }

  try {
    const raw = fs.readFileSync(resolved, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`failed to parse config file (${resolved}): ${error.message}`);
  }
}

function resolveConfig(argv) {
  const argMap = parseArgv(argv);
  const command = argMap._[0] || 'watch';
  const configFile = argMap.config || path.join(process.cwd(), 'config.json');

  const fileConfig = loadConfigFile(configFile);

  const envConfig = {
    port: process.env.PORT,
    host: process.env.HOST,
    claudeProjectsPath: process.env.CLAUDE_PROJECTS_PATH,
    activeTimeoutSec: process.env.ACTIVE_TIMEOUT_SEC,
    staleTimeoutSec: process.env.STALE_TIMEOUT_SEC,
    enablePokeapiSprites: process.env.ENABLE_POKEAPI_SPRITES
  };

  const cliConfig = {
    port: argMap.port,
    host: argMap.host,
    claudeProjectsPath: argMap.claudeProjectsPath || argMap.path || argMap.claudePath,
    activeTimeoutSec: argMap.activeTimeoutSec || argMap.activeTimeout,
    staleTimeoutSec: argMap.staleTimeoutSec || argMap.staleTimeout,
    enablePokeapiSprites: argMap.enablePokeapiSprites
  };

  const merged = {
    ...DEFAULTS,
    ...fileConfig,
    ...envConfig,
    ...cliConfig
  };

  return {
    command,
    config: {
      port: parseNumber(merged.port, DEFAULTS.port),
      host: merged.host || DEFAULTS.host,
      claudeProjectsPath: path.resolve(merged.claudeProjectsPath || DEFAULTS.claudeProjectsPath),
      activeTimeoutSec: parseNumber(merged.activeTimeoutSec, DEFAULTS.activeTimeoutSec),
      staleTimeoutSec: parseNumber(merged.staleTimeoutSec, DEFAULTS.staleTimeoutSec),
      enablePokeapiSprites: parseBoolean(merged.enablePokeapiSprites, DEFAULTS.enablePokeapiSprites)
    }
  };
}

function usage() {
  return [
    'Usage:',
    '  node cli.js watch [--port 8787] [--path ~/.claude/projects] [--pokeapi]',
    '  node cli.js mock  [--port 8787] [--pokeapi]',
    '',
    'Config precedence:',
    '  defaults < config.json < env vars < CLI flags',
    '',
    'Env vars:',
    '  PORT, HOST, CLAUDE_PROJECTS_PATH, ACTIVE_TIMEOUT_SEC, STALE_TIMEOUT_SEC, ENABLE_POKEAPI_SPRITES'
  ].join('\n');
}

function nowMs() {
  return Date.now();
}

function createMockDriver(state) {
  const agents = new Map();
  const sessions = [
    { projectId: 'demo-project-a', sessionId: 'session-a' },
    { projectId: 'demo-project-b', sessionId: 'session-b' }
  ];

  let timer = null;

  function randomAgent() {
    const all = Array.from(agents.values());
    if (all.length === 0) {
      return null;
    }
    return all[Math.floor(Math.random() * all.length)];
  }

  function addBaseAgents() {
    for (const session of sessions) {
      const agentId = `${session.sessionId}:main`;
      agents.set(agentId, {
        agentId,
        parentId: undefined,
        projectId: session.projectId,
        sessionId: session.sessionId
      });
      state.applyEvent({
        type: EVENT_TYPES.AGENT_SEEN,
        agentId,
        ts: nowMs(),
        meta: session
      });
    }
  }

  function spawnSubAgent() {
    const parent = randomAgent();
    if (!parent) {
      return;
    }

    const childId = `${parent.sessionId}:sub-${crypto.randomBytes(2).toString('hex')}`;
    if (agents.has(childId)) {
      return;
    }

    const meta = {
      projectId: parent.projectId,
      sessionId: parent.sessionId,
      parentId: parent.agentId
    };

    agents.set(childId, {
      agentId: childId,
      parentId: parent.agentId,
      projectId: parent.projectId,
      sessionId: parent.sessionId
    });

    state.applyEvent({
      type: EVENT_TYPES.SUBAGENT_SPAWN,
      agentId: childId,
      ts: nowMs(),
      meta
    });
  }

  function emitRandomActivity() {
    const target = randomAgent();
    if (!target) {
      return;
    }

    const ts = nowMs();
    const baseMeta = {
      projectId: target.projectId,
      sessionId: target.sessionId,
      parentId: target.parentId
    };

    state.applyEvent({
      type: EVENT_TYPES.AGENT_SEEN,
      agentId: target.agentId,
      ts,
      meta: baseMeta
    });

    const roll = Math.random();
    if (roll < 0.25) {
      state.applyEvent({
        type: EVENT_TYPES.TOOL_START,
        agentId: target.agentId,
        ts,
        meta: { ...baseMeta, toolName: ['bash', 'read_file', 'search', 'edit'][Math.floor(Math.random() * 4)] }
      });
      state.applyEvent({
        type: EVENT_TYPES.TOOL_END,
        agentId: target.agentId,
        ts: ts + 150,
        meta: { ...baseMeta, toolName: state.agents.get(target.agentId)?.lastTool || 'tool' }
      });
      return;
    }

    if (roll < 0.8) {
      state.applyEvent({
        type: EVENT_TYPES.ASSISTANT_OUTPUT,
        agentId: target.agentId,
        ts,
        meta: baseMeta
      });
      return;
    }

    state.applyEvent({
      type: EVENT_TYPES.WAITING,
      agentId: target.agentId,
      ts,
      meta: baseMeta
    });
  }

  return {
    start() {
      addBaseAgents();
      timer = setInterval(() => {
        if (Math.random() < 0.16 && agents.size < 18) {
          spawnSubAgent();
        }
        emitRandomActivity();
      }, 700);
      timer.unref();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    }
  };
}

async function run() {
  const { command, config } = resolveConfig(process.argv.slice(2));

  if (command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  if (command !== 'watch' && command !== 'mock') {
    process.stderr.write(`Unknown command: ${command}\n\n${usage()}\n`);
    process.exitCode = 1;
    return;
  }

  const state = new AgentState({
    activeTimeoutSec: config.activeTimeoutSec,
    staleTimeoutSec: config.staleTimeoutSec
  });

  const server = new DashboardServer({
    host: config.host,
    port: config.port,
    publicDir: path.join(process.cwd(), 'public'),
    state,
    publicConfig: {
      enablePokeapiSprites: config.enablePokeapiSprites
    }
  });

  server.on('info', (message) => process.stdout.write(`[server] ${message}\n`));
  server.on('warn', (message) => process.stderr.write(`[server] ${message}\n`));

  let watcher = null;
  let mock = null;

  if (command === 'watch') {
    watcher = new TranscriptWatcher({
      rootPath: config.claudeProjectsPath
    });

    watcher.on('info', (message) => process.stdout.write(`[watcher] ${message}\n`));
    watcher.on('warn', (message) => process.stderr.write(`[watcher] ${message}\n`));
    watcher.on('event', (event) => state.applyEvent(event));
  } else {
    mock = createMockDriver(state);
  }

  await server.start();

  process.stdout.write(`[config] mode=${command} port=${config.port} path=${config.claudeProjectsPath}\n`);
  process.stdout.write(`[dashboard] http://${config.host}:${config.port}\n`);

  if (watcher) {
    await watcher.start();
  }

  if (mock) {
    mock.start();
    process.stdout.write('[mock] synthetic event generator started\n');
  }

  const tickTimer = setInterval(() => state.tick(Date.now()), 1000);
  tickTimer.unref();

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    process.stdout.write(`\n[shutdown] received ${signal}, stopping...\n`);

    clearInterval(tickTimer);

    if (watcher) {
      await watcher.stop();
    }

    if (mock) {
      mock.stop();
    }

    await server.stop();
    process.stdout.write('[shutdown] complete\n');
    process.exit(0);
  }

  process.on('SIGINT', () => {
    shutdown('SIGINT').catch((error) => {
      process.stderr.write(`[shutdown] ${error.message}\n`);
      process.exit(1);
    });
  });

  process.on('SIGTERM', () => {
    shutdown('SIGTERM').catch((error) => {
      process.stderr.write(`[shutdown] ${error.message}\n`);
      process.exit(1);
    });
  });
}

run().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
