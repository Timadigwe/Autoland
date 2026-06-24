# Architecture Design Document

## 1. System Overview

The Intelligent DLMM bot manages concentrated liquidity on Meteora DLMM pools. Execution logic (drift detection, rebalance building) is deterministic and fast. **Failure recovery is autonomous**: a single AI agent with read-only tools decides retries within hard safety guardrails.

**Submission path: Jito bundles only.** Public RPC is used for reads, `simulateBundle`, and confirmation fallback — never for transaction submission.

---

## 2. Component Architecture

### A. Data Ingestion (`GrpcClient` + `TipBalanceWatcher`)

- Jito tip account balance deltas (not mainnet tip tx firehose)
- Slot updates → `JitoSubmitter`
- Transaction status → dynamic per-signature subscription
- Bounded event queue with async drain (backpressure-safe)

### B. Tip Intelligence (`TipTracker`)

- Rolling p50/p90/p99 from tip account deltas
- `getRecommendedTipLamports()` with margin + caps

### C. Position Engine (`PositionEngine`)

State machine: `NO_POSITION` → deploy | `IN_RANGE` → hold | `DRIFT_DETECTED` → rebalance | `REBALANCING` / `CONFIRMING` / `FAILED`

### D. Rebalance Builder (`RebalanceBuilder`)

Initial deploy uses wallet balances only (no swap). Rebalance: withdraw → mandatory in-pool swap (binary-search partial swap if full quote fails) → add liquidity. Supports per-attempt `slippageBps` override.

### E. Jito Submission (`JitoSubmitter` + `JitoBundleSimulator`)

1. Build & sign bundle with fresh blockhash
2. **`simulateBundle`** via Jito-enabled RPC (atomic, in-order)
3. Sequential regional `sendBundle`
4. Record outcomes → `HealthMonitor`

### F. Health Monitor (`HealthMonitor`)

Rolling 5-minute window of:
- RPC latency / failures
- Jito accept rate / rate limits
- Simulation pass rate
- gRPC queue depth / dropped events

Included in every `ExecutionIncident.health` snapshot.

### G. Autonomous Failure Recovery

```
Failure
  → parse error (phase, code, confidence)
  → ExecutionIncident + sessionMemory + health
  → save logs/incidents/{uuid}.json
  → route decision:
       high-confidence shortcut? → deterministic (optional speed path)
       low confidence / unknown / repeated / attempt ≥ N → AI agent
  → applySafetyGuardrails (caps, phase rules, HALT conditions)
  → RETRY | DEFER | HALT
```

#### ExecutionSession (learn within session)

Per rebalance execution, tracks:
- All incidents this session
- All decisions + mutations applied
- Defer count
- Repeated failure detection (same errorType + phase ≥ 2)

Passed to AI in every incident and via `read_session_memory` tool.

#### Confidence routing

| Confidence | When | Decision path |
|------------|------|---------------|
| **high** | Parsed program code (6003), blockhash stale | Optional deterministic shortcut |
| **medium** | Jito reject, auction drop | AI agent (or shortcut if not repeated) |
| **low** | Unknown, transient, network, confirm timeout | **AI agent immediately** |

#### AI agent tools (read-only)

| Tool | Purpose |
|------|---------|
| `read_log_tail` | Recent `[ENGINE]`/`[JITO]`/`[STRATEGY]` lines |
| `read_lifecycle_events` | Recent `lifecycle-log.jsonl` |
| `read_incident` | Structured incident JSON |
| `read_session_memory` | Session incidents + mutations + **attempt timeline** |
| `get_config_slice` | Relevant env limits |
| `get_tip_market_stats` | p50/p90/p99, recommended, sample count |
| `get_pool_snapshot` | Cached active bin, position range, drift |
| `get_attempt_timeline` | Per-attempt funnel (build→preflight→sim→jito→confirm) |
| `list_similar_incidents` | Past incidents same errorType+phase with outcomes |
| `read_simulation_logs` | Last simulateBundle logs this session |

#### Pre-flight gate (deterministic, no LLM)

Before Jito submit each attempt:
1. **Bin freshness** — if active bin moved > `PREFLIGHT_MAX_BIN_DRIFT` since build → rebuild (no attempt consumed)
2. **Tip check** — if `partial_swap_used` or tip < 80% recommended → bump to recommended
3. **Health + underbid** — defer if health degraded and underbid

Tip-only changes do not require tx rebuild; blockhash refreshed at submit.

#### Actions

| Action | Meaning |
|--------|---------|
| **RETRY** | Apply mutations, next attempt in loop |
| **DEFER** | Wait `waitMs`, exit cycle, retry on next poll (network/transient) |
| **HALT** | Stop execution, set `FAILED` |

#### Safety guardrails (always code-enforced)

- Tip ≤ `JITO_MAX_TIP_LAMPORTS`
- Slippage ≤ `AI_MAX_SLIPPAGE_BPS_CAP`
- No tip escalation on `bundle_simulation` + slippage errors
- HALT after skip_swap + persistent slippage
- Max defers per session (`AI_MAX_DEFERS_PER_SESSION`)

### H. Confirmation Tracker (`ConfirmationTracker`)

gRPC status + Jito inflight/bundle status + RPC polling with tiered timeouts.

---

## 3. Failure Handling Flow

```
simulateBundle fail (6003)
  → confidence=high, phase=bundle_simulation
  → agent: slippageBps↑ or skipSwap (guardrail blocks tip-only)

Jito reject / 429
  → confidence=low/medium
  → agent: tip↑ or DEFER if health degraded

Confirm timeout
  → confidence=low
  → agent: tip↑ or DEFER

Repeated same failure twice
  → force agent even on attempt 1
```

---

## 4. Configuration

See `env.example`. Key AI/recovery vars:

```
AI_ADVISOR_AFTER_ATTEMPT=2
AI_USE_AGENT_FOR_LOW_CONFIDENCE=true
AI_MAX_DEFERS_PER_SESSION=2
AI_DEFAULT_DEFER_MS=10000
AI_MAX_SLIPPAGE_BPS_CAP=2500
```

---

## 5. Logs & Artifacts

| Path | Content |
|------|---------|
| `logs/dlmm-mm-YYYY-MM-DD.log` | Full bot log |
| `logs/lifecycle-log.jsonl` | Tx lifecycle events |
| `logs/incidents/{uuid}.json` | Structured failure incidents |
