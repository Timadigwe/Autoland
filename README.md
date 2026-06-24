# Intelligent DLMM Market Maker

Production-oriented Meteora DLMM market maker for Solana. Streams live Jito tip data via account balance deltas, monitors pool drift, rebalances via withdraw → in-pool swap → add liquidity, and submits exclusively through Jito bundles.

## Features

- **Live tip intelligence** — Yellowstone gRPC account subscriptions on 8 Jito tip accounts; rolling p90/p99 baseline without the mainnet tip tx firehose
- **Backpressure-safe gRPC** — bounded event queue with drop-oldest policy; async batch drain (no inline processing on receive path)
- **Position engine** — cold-starts positions when none exist; rebalances when active bin drifts beyond threshold
- **Meteora in-pool swaps** — 50/50 rebalance using the same DLMM pool (not Jupiter)
- **Jito-only submission** — sequential regional endpoint submit (stop on first acceptance), tip verification, success-only cooldown
- **Robust confirmation** — gRPC transaction status + Jito inflight/bundle status + tiered timeouts
- **Autonomous failure recovery** — AI agent with log/incident/session tools; confidence-based routing; DEFER for transient issues
- **Session memory** — tracks mutations tried per rebalance so agent doesn't repeat failed actions
- **Health monitoring** — RPC/Jito/sim/grpc snapshots included in every failure incident

## Quickstart

1. Copy `env.example` to `.env` and configure:
   - `GRPC_URL`, `X_TOKEN`, `RPC_URL`
   - `DLMM_TARGET_POOL`, `PRIVATE_KEYS_FILE`
   - `OPENROUTER_API_KEY`
2. `npm install`
3. `npm run build`
4. `npm start`

Start with `DRY_RUN=true` to validate transaction building without submitting bundles.

Press **`f`** at runtime to inject a Jito failure test (expired blockhash).

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full system design.

```
gRPC (tip account deltas) ──► TipTracker (p90/p99)
                                    │
PositionEngine ──► RebalanceBuilder ──► JitoSubmitter ──► ConfirmationTracker
                    ▲                                      │
                    └──────── FailureAdvisor ◄─────────────┘
```

## Key Environment Variables

| Variable | Purpose |
|----------|---------|
| `DLMM_TARGET_POOL` | Meteora DLMM pool address |
| `DRIFT_THRESHOLD_BINS` | Rebalance when drift exceeds this (default: 5) |
| `STRATEGY_BIN_COUNT` | Bins around active bin (default: 11) |
| `DLMM_STRATEGY` | `Curve`, `Spot`, or `BidAsk` |
| `JITO_MIN_TIP_LAMPORTS` | Floor tip until enough samples |
| `TIP_MIN_SAMPLES_BEFORE_EXECUTION` | Min gRPC tip samples before first deploy/rebalance (default: 50) |
| `PREFLIGHT_MIN_TIP_RATIO` | Bump tip pre-submit if below this fraction of recommended (default: 0.8) |
| `PREFLIGHT_MAX_BIN_DRIFT` | Rebuild bundle if active bin moved more than N bins since build (default: 2) |
| `SWAP_BIN_ARRAY_COUNT` | Bin arrays fetched for in-pool swap quote (default: 8) |
| `SWAP_MAX_EXTRA_BIN_ARRAYS` | Extra bin arrays attached to swap tx (default: 3, max SDK limit) |
| `JITO_MAX_TIP_LAMPORTS` | Hard tip ceiling (default: 5M lamports) |
| `GRPC_MAX_QUEUE_SIZE` | Max gRPC event queue depth before dropping oldest (default: 5000) |
| `GRPC_TIP_SAMPLE_INTERVAL_MS` | Min ms between tip samples (default: 250) |
| `AI_ADVISOR_AFTER_ATTEMPT` | Force AI from attempt N even if confidence high (default: 2) |
| `AI_MAX_DEFERS_PER_SESSION` | Max DEFER actions per rebalance (default: 2) |
| `DRY_RUN` | Build txs but skip Jito submission |

## Scripts

```bash
npm run build          # Compile TypeScript
npm start              # Run compiled bot
npm run dev            # Run with ts-node
npm run test:ai-agent  # Test tip tracker + failure advisor
```

## Project Layout

```
src/
├── core/           bot.ts, position-engine.ts
├── execution/      rebalance-builder, jito-submitter, jito-bundle-simulator, confirmation-tracker
├── intelligence/   tip-tracker, failure-advisor, advisor-tools, execution-session, health-monitor
├── stream/         grpc-client, tip-balance-watcher
├── services/       wallet-manager
└── types/          config, execution-state
```

## License

MIT
