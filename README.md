# pi-commandcode-provider

A [Pi](https://pi.dev) provider extension for the [Command Code Provider API](https://commandcode.ai/docs/provider-api).

Command Code exposes one base URL that speaks three different wire protocols, and its `/models` endpoint
carries almost no metadata. This extension handles both problems:

- **Correct routing per model.** Claude models go to `/messages` (Anthropic), GPT models go to `/responses`,
  everything else defaults to `/chat/completions`. The live `supported_endpoints` field decides, with
  name-based fallbacks for new models.
- **Real model metadata.** Context windows, output limits, vision support, reasoning/thinking configuration,
  compat quirks and per-token cost come from a bundled catalog generated from Pi's own upstream metadata,
  models.dev and live capability probes.
- **Fresh without being chatty.** The bundled catalog works offline. A live refresh runs at most once per
  TTL (6h by default) and the merged result is persisted through Pi's model store, so startup is instant.
- **Native Pi integration.** A real `ApiKeyAuth` provider, so `/login commandcode` and `/model` behave like
  any built-in provider. `/commandcode` reports status and can force a refresh.
- **Optional ZDR.** `CMD_ZDR=1` adds `x-cmd-zdr: 1`, the same zero-data-retention opt-in as the Command Code CLI.

## Install

```bash
pi install npm:pi-commandcode-provider
# or, before it is on npm:
pi install git:github.com/safzanpirani/pi-commandcode-provider
```

Try it for one run without installing:

```bash
pi -e ./src/index.ts
```

## Authenticate

Run `/login commandcode` and paste a key from Command Code Studio → API keys. The key is validated against
`GET /models` before it is stored.

For headless use, set `COMMANDCODE_API_KEY` (or `CMD_API_KEY`). If neither is set, the extension falls back
to the Command Code CLI's own `~/.commandcode/auth.json`, so an existing CLI login works without any setup.

> If you previously configured `commandcode` in `~/.pi/agent/models.json`, remove that block. A `models`
> array in `models.json` replaces this provider's model list, so the picker would only show the models
> listed there (and it usually contains your API key in plaintext).

## Model routing

| Models | Endpoint | Pi API |
|---|---|---|
| `claude-*` | `/messages` | `anthropic-messages` |
| `gpt-*`, `openai/*`, `o*`, `codex*` | `/responses` | `openai-responses` |
| everything else | `/chat/completions` | `openai-completions` |

Routing follows the live `supported_endpoints` array, so a model that moves between endpoints is handled on
the next refresh. Claude models only exist on `/messages`; asking for them anywhere else is a 400.

## Commands

- `/commandcode status` — auth source, model counts, catalog age, TTL, ZDR state
- `/commandcode refresh` — force a live `/models` fetch and persist the merged catalog
- `/commandcode models` — list registered models with their wire protocol
- `/commandcode help`

## How the catalog stays fresh

```
bundled snapshot  →  offline baseline, always available
live /models      →  id, name, context window, supported_endpoints
merge             →  snapshot metadata + live data + family fallbacks
persist           →  Pi model store (per agent dir), reused next start
```

- Startup restores the persisted catalog without network access.
- A session-start refresh checks the catalog in the background, but the provider skips the network while
  the catalog is younger than the TTL.
- `/commandcode refresh` (or `pi update --models`) bypasses the TTL.
- `PI_COMMANDCODE_TTL_MS` overrides the 6h window.

## Regenerating the bundled catalog

The snapshot in `src/catalog/models.generated.ts` is generated, not hand-written:

```bash
export COMMANDCODE_API_KEY=...        # or use the CLI's auth file
npm run sync                          # ~1 HTTP request
npm run sync:vision                   # also probes every model for real image support
node scripts/sync-catalog.mjs --no-modelsdev --dry-run
```

Metadata precedence (lowest to highest): models.dev → Pi's built-in catalog → `scripts/seed-facts.json` →
`scripts/overrides.json` → empirical vision probes.

Notes on the pipeline:

- Vision is probed, never inferred. The gateway happily accepts an image for a text-only model and returns
  200 with empty output, so `--probe-vision` sends a 64×64 red PNG and checks whether the model names the
  colour (including in its reasoning channel).
- A per-model `reasoning` flag decides whether Pi offers `/thinking`.
- `compat` and `thinkingLevelMap` are only carried over when the upstream entry uses the same wire protocol
  as the routed endpoint.
- Subscription catalogs (Qwen token plans, Kimi coding) report zero per-token cost, so their cost facts are
  skipped instead of understating your bill.

Add `{"match": "vendor/*", ...}` entries to `scripts/overrides.json` for anything the pipeline gets wrong,
then re-run `npm run sync`.

## Costs

Command Code bills at underlying API rates with no markup, and deal multipliers are applied to usage, not to
per-token prices. Pi's cost display uses the underlying per-token rates, so promotional multipliers and
plan credits are not reflected. Models ending in `:free` are reported as zero-cost.

## Plan gating

Models outside your plan return `403 MODEL_NOT_IN_PLAN` (or `403 upgrade_required` on the Go plan). The
extension does not hide them, because a model that is gated for one plan is available on another; the error
is surfaced as-is. `/commandcode models` and `/model` show what the API advertises.

## Decision model

`typesafe/jev` (TypeSafe System One) is registered as a classifier model backed by `POST /systemone`. It is
usable through Pi's `codemode` tool like other classifier providers, and it costs nothing on the Command
Code API.

## Development

```bash
npm install
npm run typecheck
npm test                              # unit tests; live tests run when a key is present
pi -e ./src/index.ts --list-models commandcode --offline
pi -e ./src/index.ts --provider commandcode --model deepseek/deepseek-v4.1-flash "hello"
```

Live tests skip models your plan cannot reach, so they stay green on any plan.

## Layout

```
src/
  index.ts              extension entry: registerProvider + /commandcode
  provider.ts           Provider assembly: models, refresh, persistence, routing hookup
  auth.ts               /login flow, env keys, CLI auth migration
  remote.ts             GET /models client with typed errors
  stream.ts             per-API dispatch to Pi's built-in implementations + ZDR header
  classify.ts           typesafe/jev classifier wiring
  command.ts            /commandcode subcommands
  endpoints.ts          base URLs, endpoint routing, env constants
  catalog/
    types.ts            structural catalog types
    family.ts           vendor heuristics and conservative fallbacks
    merge.ts            live + snapshot + fallback merge (pure, unit-tested)
    models.generated.ts generated snapshot (do not edit)
scripts/
  sync-catalog.mjs      catalog generator (matching, cost, vision probes)
  seed-facts.json       Command Code capability tags seen in the wild
  overrides.json        hand-maintained corrections
test/                   unit, provider lifecycle and live wire-format tests
```

## Limitations

- Deals and plan multipliers are not reflected in cost estimates.
- A brand-new model that is missing from the snapshot still works, but with conservative defaults (32K max
  output, no vision, no reasoning) until the next `npm run sync`.
- Vision probes cost a small number of tokens per model and are therefore opt-in.
- The classifier implementation is imported lazily from `@earendil-works/pi-ai/api/typesafe-system-one.lazy`;
  if that path is unavailable in a future Pi version, classification degrades to an error result while the
  rest of the provider keeps working.

## License

MIT
