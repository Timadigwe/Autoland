# Proposal: Rich Error Context for Autonomous Recovery

## Problem

The failure advisor receives **narrative context** (situation brief, build warnings, tip market) but often **loses the actual on-chain failure signal**. Example from production:

- `simulateBundle` failed with `Custom: 3005` (Meteora `AccountNotEnoughKeys` on `bin_array`)
- Parser classified as `Unknown` → low confidence
- Agent saw `partial_swap_used` warnings and recommended **slippage increases** (wrong fix)

**Root cause:** classification is too coarse, simulation logs are truncated or empty, and unparsable errors are not passed through verbatim to the LLM.

---

## Goals

1. **Deterministic fixes first** — known program codes map to concrete actions without LLM guessing
2. **Raw fidelity** — every incident includes unparsed `rawErr`, full simulation logs, and log tail
3. **Structured + raw** — parsed `programFailure` when possible; always attach raw payload when not
4. **Lookup tools** — agent can resolve unknown codes via local catalog (+ future web search)

---

## Architecture

```
simulateBundle / build failure
        │
        ▼
  parseProgramFailure(rawErr, logs)  ──► known code? high-confidence shortcut
        │
        ▼
  ExecutionIncident
    • programFailure { code, anchor, humanReadable, suggestedFix }
    • rawErr (full JSON)
    • simulationLogs (full, not truncated)
    • rawLogTail (recent WARN/ERROR/INFO from logger)
        │
        ▼
  buildSituationBrief() — programFailure FIRST, warnings second
        │
        ▼
  FailureAdvisor + prefetchedContext + tools
    • lookup_program_error
    • read_simulation_failure
    • read_log_tail
```

---

## Phase 1 (implemented in this PR)

### Bin array fix (3005)

- `getBinArrayForSwap(swapY, count)` with configurable count (default 8)
- `swapQuote(..., isPartialFill, maxExtraBinArrays)` — partial fills + up to 3 extra bin arrays
- Config: `SWAP_BIN_ARRAY_COUNT`, `SWAP_MAX_EXTRA_BIN_ARRAYS`

### Error parser

- Map Meteora codes: **3005** → `AccountNotEnoughKeys`, **6003** → slippage
- Extract anchor name from simulation logs when present
- New failure type routing for bin-array errors

### Raw log pass-through

- `ExecutionIncident.programFailure` — structured parse + human-readable hint
- `ExecutionIncident.rawErr` — full instruction error JSON
- `ExecutionIncident.rawLogs` — simulation logs + logger tail (unparsable content preserved)
- Situation brief leads with `programFailure`, not build warnings
- Prefetch includes full `simulationLogs` and `rawLogs`

### Advisor tools

- `lookup_program_error(code, program?)` — local Meteora DLMM catalog
- `read_simulation_failure` — current session structured failure

---

## Phase 2 (future)

- **Re-simulate failing tx** via RPC when bundle sim returns empty logs
- **`search_error` tool** — GitHub/docs search for unknown codes
- **Deterministic guardrails** — block slippage-only retry when code is 3005
- **Cross-session outcome learning** — weight mutations that resolved similar codes
- **Optional Solana RPC tool** — runtime equivalent of Solana MCP (not IDE MCP)

---

## Success criteria

| Scenario | Before | After |
|----------|--------|-------|
| 3005 bin_array | Unknown → slippage loop | Known → rebuild with extra bin arrays |
| Empty sim logs | Agent blind | rawErr + rawLogTail still in payload |
| New unknown code | Guessing | Catalog miss → agent uses lookup tool + raw JSON |

---

## Config reference

| Variable | Default | Purpose |
|----------|---------|---------|
| `SWAP_BIN_ARRAY_COUNT` | 8 | Bin arrays fetched for swap quote |
| `SWAP_MAX_EXTRA_BIN_ARRAYS` | 3 | Extra bin arrays included in swap tx |
| `PREFLIGHT_MIN_TIP_RATIO` | 0.8 | Pre-submit tip floor vs recommended |
| `PREFLIGHT_MAX_BIN_DRIFT` | 2 | Rebuild if active bin moved N bins |
