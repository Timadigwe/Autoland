# AutoLand: Intelligent Transaction Stack

AutoLand is an advanced autonomous transaction infrastructure for Solana. It dynamically prices tips, streams lifecycle events via Yellowstone gRPC, implements strict Jito `inSubmitWindow` logic, and uses a local **Qwen 2.5 7B** (vLLM) AI agent to safely manage retry logic during faults.

## Overview

Unlike standard trading bots, AutoLand separates the complex transaction lifecycle routing into a core SDK (`@autoland/core`). Developer bots—like the included Meteora DLMM market maker example—simply pass their compiled instructions to `autoland.submit()`, and AutoLand handles the rest.

### Architectural Answers based on Operational Data

**Question 1: What does the delta between `processed_at` and `confirmed_at` tell you about network health at the time of submission?**
> The delta measures how long the cluster took to reach a supermajority vote on the block containing the transaction. A small delta (< 500 ms) indicates healthy, fast voting and low fork pressure. A large or widening delta indicates vote latency, high fork churn, or validator degradation. AutoLand uses its Congestion Oracle to track this delta in real-time over a 64-slot window to dynamically scale tip multipliers.

**Question 2: Why should you never use `finalized` commitment when fetching a blockhash for a time-sensitive transaction?**
> A blockhash is valid for roughly 150 slots (~60s). Because `finalized` lags behind `confirmed` by about 31-32 slots (~13s), fetching at `finalized` burns roughly 20% of your blockhash's validity window before you even submit the transaction. We fetch at `confirmed` to maximize the usable timeframe without risking the chain reverting on `processed`.

**Question 3: What happens to your bundle if the Jito leader skips their slot?**
> The bundle is dropped entirely. Bundles are only processed by the specific Jito block engine when its scheduled validator is producing the block. If that leader skips, the bundle is never ingested by the chain. AutoLand detects this via the `LeaderWindowDetector`, classifies it as a dropped bundle, and the AI agent instructs the system to hold and retry on the *next* scheduled Jito leader slot.

## Architecture Documentation

Please refer to [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the complete design document outlining data flow, AI agent guardrails, and fault mitigation strategies.
