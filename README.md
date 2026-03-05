# Claude Code Agent Pixel Dashboard

Local-only Node.js watcher + web dashboard that tails Claude Code transcript JSONL files and renders live pixel-sprite agents on an HTML Canvas.

## Features

- Dependency-free runtime (Node built-ins only, no npm packages required)
- Watches Claude Code transcripts under `~/.claude/projects` (configurable)
- Incremental JSONL tailing (tracks file offsets, no full reread on each change)
- Real-time updates via Server-Sent Events (SSE)
- Multi-project / multi-session support
- Agent state machine with active/idle/stale lifecycle
- Sub-agent spawn visualization with parent-child links
- Canvas pixel office scene with animated sprites
- Optional runtime sprite provider for PokeAPI hotlinked images
- `mock` mode for UI testing without real Claude logs

## Quick Start

```bash
node cli.js watch
```

Open:

- `http://127.0.0.1:8787`

Mock mode:

```bash
node cli.js mock
```

## Commands

```bash
node cli.js watch [--port 8787] [--path ~/.claude/projects] [--pokeapi]
node cli.js mock  [--port 8787] [--pokeapi]
node cli.js help
```

## Configuration

Config precedence:

1. Built-in defaults
2. `config.json` (project root, optional)
3. Environment variables
4. CLI flags

Supported keys:

- `port` (default: `8787`)
- `claudeProjectsPath` (default: `~/.claude/projects`)
- `activeTimeoutSec` (default: `60`)
- `staleTimeoutSec` (default: `300`)
- `enablePokeapiSprites` (default: `false`)

Environment variables:

- `PORT`
- `HOST`
- `CLAUDE_PROJECTS_PATH`
- `ACTIVE_TIMEOUT_SEC`
- `STALE_TIMEOUT_SEC`
- `ENABLE_POKEAPI_SPRITES`

Example `config.json`:

```json
{
  "port": 8787,
  "claudeProjectsPath": "/home/you/.claude/projects",
  "activeTimeoutSec": 60,
  "staleTimeoutSec": 300,
  "enablePokeapiSprites": false
}
```

## Event Model

Internal normalized schema:

- `type`: `AGENT_SEEN | TOOL_START | TOOL_END | ASSISTANT_OUTPUT | WAITING | SUBAGENT_SPAWN`
- `agentId`
- `ts` (epoch ms)
- `meta` (`toolName`, `projectId`, `sessionId`, `parentId`, `filePath`, etc.)

## Claude Transcript Heuristics

The parser uses conservative mappings:

- `tool_use` blocks or entries -> `TOOL_START`
- `tool_result` blocks or entries -> `TOOL_END`
- assistant role / assistant message / delta-like output -> `ASSISTANT_OUTPUT`
- explicit waiting-like state (`waiting`, `awaiting_user`, `pause_turn`, etc.) -> `WAITING`
- explicit spawn-like event names containing `spawn` + `agent/sub` -> `SUBAGENT_SPAWN`
- every parsed row with identifiable context emits `AGENT_SEEN`

Sub-agent inference:

- If a new `agentId` appears with `parentId`, the state layer infers a spawn relationship even if no explicit spawn entry exists.

Malformed JSON lines are skipped safely.

## Architecture

- `cli.js`: command entrypoint, config merge, mode orchestration
- `watcher.js`: recursive discovery + fs watchers + incremental tailing
- `parser.js`: transcript line normalization into internal events
- `state.js`: per-agent state machine, timeouts, ring buffer, snapshots
- `server.js`: HTTP static server + `/api/state` + `/events` SSE
- `public/`: dashboard frontend (`index.html`, `app.js`, `style.css`)

HTTP routes:

- `/` -> dashboard HTML
- `/app.js` -> client app
- `/style.css` -> CSS
- `/events` -> SSE stream
- `/api/state` -> current full snapshot

## Sprite Providers

Providers are pluggable in `public/app.js`:

- `LocalSpriteProvider` (default): generated original pixel monsters
- `PokeApiSpriteProvider` (optional): runtime fetch from PokeAPI sprite URLs

To add a provider:

1. Implement `getSprite(agent, frame, status)`.
2. Return an `Image` or `Canvas`.
3. Add selection logic in `spriteProvider()`.

## Pokemon Mode Notice

- This project ships with original generated sprites only.
- No Pokemon images are included in this repository.
- Optional Pokemon mode fetches third-party sprite assets at runtime (hotlink only).
- Users are responsible for legal/compliance review of third-party assets.

Trademark notice: Pokemon and related marks are trademarks of their respective owners. This project is not affiliated with or endorsed by those owners.

## Platform Notes

- Tested for local usage on macOS/Linux.
- Windows may work but is not the primary target.

## Development Safety

- No network calls are required for normal mode.
- Optional network use only for PokeAPI sprite mode in browser.
- No writes outside this repository except OS-level transcript reads from configured Claude path.
