# Bundle Simulation & Failure Recovery

## Pre-submit: `simulateBundle`

Uses Jito-enabled RPC `simulateBundle` — atomic in-order simulation of withdraw → swap → add.

Requires `RPC_URL` with `simulateBundle` support. Fallback: `SIMULATE_BUNDLE_FALLBACK_LOCAL=true`.

## Failure recovery architecture

Every failure produces an **ExecutionIncident** saved to `logs/incidents/{uuid}.json`:

- **phase** — build | bundle_simulation | jito_submit | confirmation
- **confidence** — high | medium | low
- **health** — RPC/Jito/sim/grpc snapshot
- **sessionMemory** — incidents + mutations tried this rebalance

### Decision routing

| Condition | Handler |
|-----------|---------|
| confidence=low, Unknown, Transient, NetworkError | AI agent immediately |
| Same errorType+phase twice in session | AI agent |
| attempt ≥ `AI_ADVISOR_AFTER_ATTEMPT` | AI agent |
| high-confidence slippage on sim | Optional deterministic shortcut |

### AI agent tools

`read_log_tail`, `read_lifecycle_events`, `read_incident`, `read_session_memory`, `get_config_slice`

### Actions

- **RETRY** — apply mutations (tip, slippage, skipSwap), next attempt
- **DEFER** — wait and exit cycle; retry on next poll (network/transient)
- **HALT** — stop; safety guardrails enforce caps

## Configuration

```env
AI_ADVISOR_AFTER_ATTEMPT=2
AI_USE_AGENT_FOR_LOW_CONFIDENCE=true
AI_MAX_TOOL_ROUNDS=3
AI_MAX_SLIPPAGE_BPS_CAP=2500
AI_MAX_DEFERS_PER_SESSION=2
AI_DEFAULT_DEFER_MS=10000
AI_MAX_DEFER_MS=60000
SIMULATE_BUNDLE_FALLBACK_LOCAL=false
```
