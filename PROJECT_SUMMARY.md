# Project Summary

## Implemented

### Core
- `DlmmBot` — orchestrator with autonomous failure recovery
- `PositionEngine` — drift detection, cold-start, state machine
- `ExecutionSession` — per-rebalance memory (incidents, decisions, mutations tried)

### Execution
- `RebalanceBuilder` — withdraw → swap → add (slippageBps override, skip swap)
- `JitoSubmitter` + `JitoBundleSimulator` — simulateBundle + sequential sendBundle
- `ConfirmationTracker` — gRPC + Jito + RPC confirmation
- `HealthMonitor` — RPC/Jito/sim/grpc health snapshots

### Intelligence
- `TipTracker` — rolling tip percentiles
- `FailureAdvisor` — confidence routing + AI agent with tools
- `AdvisorTools` — read logs, incidents, session memory, config
- `error-parser` — program error codes, confidence classification
- `safety-guardrails` — bounded mutations, phase rules, HALT conditions
- `IncidentStore` — structured JSON in `logs/incidents/`

### Infrastructure
- `GrpcClient` + `TipBalanceWatcher` — backpressure-safe tip intelligence
- `WalletManager`, `Logger`

## Module Layout

```
src/
├── core/bot.ts, position-engine.ts
├── execution/rebalance-builder.ts, jito-submitter.ts, jito-bundle-simulator.ts, confirmation-tracker.ts
├── intelligence/
│   tip-tracker.ts, failure-advisor.ts, advisor-tools.ts
│   execution-incident.ts, execution-session.ts, health-monitor.ts
│   error-parser.ts, safety-guardrails.ts
├── stream/grpc-client.ts, tip-balance-watcher.ts
└── types/, utils/
```

## Recovery Behavior

1. Failure → structured incident with confidence + health + session memory
2. High-confidence shortcuts only when safe (e.g. slippage on sim)
3. Unknown/transient/repeated → AI agent with log tools
4. Guardrails enforce caps; DEFER for network issues; HALT when exhausted

## Scripts

| Command | Purpose |
|---------|---------|
| `npm run build` | Compile |
| `npm start` | Run bot |
| `npm run test:ai-agent` | Test advisor + session |
