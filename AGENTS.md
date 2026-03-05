# AGENTS.md

## Run

```bash
node cli.js watch
```

Open `http://127.0.0.1:8787`.

For development without Claude transcripts:

```bash
node cli.js mock
```

## Watcher Behavior

- Source path defaults to `~/.claude/projects` and can be overridden via config/env/CLI.
- The watcher recursively discovers `.jsonl` files.
- It tracks byte offsets per file and only reads appended bytes.
- It keeps `leftover` partial-line buffers for safe JSONL parsing.
- Malformed lines are skipped.
- New directories/files are discovered through both `fs.watch` and periodic rescans.

## Sprite Providers

Provider interface (client-side):

- `getSprite(agent, frame, status) -> HTMLImageElement | HTMLCanvasElement`

Current providers:

- `LocalSpriteProvider`: generated original pixel sprites (default)
- `PokeApiSpriteProvider`: optional runtime hotlink provider

Add a new provider:

1. Implement `getSprite` in `public/app.js`.
2. Add switching logic in `spriteProvider()`.
3. Keep provider stateless or cache in-memory only.
4. Do not commit third-party sprite binaries.

## Coding Conventions

- No external npm dependencies.
- Use Node built-in modules only.
- Keep modules small and focused.
- Preserve resilient parsing: tolerate missing/unknown transcript fields.
- Prefer explicit, simple heuristics over brittle format assumptions.
- Keep comments short and only where logic is non-obvious.

## Safety

- Do not write outside this repo.
- Exception: optional temporary cache paths may be used in future providers, but must be opt-in and never committed.
- Do not modify user Claude transcript files.
- Treat transcript input as untrusted data; parse defensively.
