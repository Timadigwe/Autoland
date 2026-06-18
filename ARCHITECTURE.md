# Architecture Design Document: Intelligent DLMM Stack

## 1. System Overview
The Intelligent DLMM Stack is a high-performance, asynchronous market-making bot designed to manage concentrated liquidity on Solana (specifically Meteora DLMM). 

The system solves the "latency vs. intelligence" trade-off by strictly separating execution logic from AI reasoning:
1. **Core Engine (Execution):** Uses a zero-latency, math-based fixed-distance threshold to instantly trigger rebalances.
2. **AI Stack (Transaction Landing):** Operates asynchronously to pre-compute tips, and synchronously on failures to mutate payloads for retries.

---

## 2. Component Architecture

### A. Data Ingestion (Yellowstone gRPC)
- **Component:** `GrpcStreamService`
- **Role:** Subscribes to Account and Slot streams to provide millisecond-accurate updates.
- **Responsibility:** Tracks live Jito tip medians (via tip account changes) and triggers the Core Engine evaluation loop every 25 slots (~10 seconds). It also tracks exact lifecycle events (`Processed`, `Confirmed`, `Finalized`) without relying on slow RPC polling.

### B. Core Engine (DLMM Fixed-Distance Trigger)
- **Component:** `DlmmMarketMaker`
- **Role:** Handles the instantaneous deployment and reshaping of liquidity.
- **Data Flow:** Every 10 seconds, it fetches the live `activeBin` from the DLMM contract. It calculates the drift `abs(activeBin - positionCenter)`.
- **Logic:** If drift > 5 bins, it triggers a `Swapless Rebalance` to re-center liquidity. Because this is pure math, execution latency is 0ms.

### C. AI Tip Intelligence (Asynchronous Background Agent)
- **Component:** `AiTippingAgent`
- **Role:** Optimizes Jito tips without blocking the execution thread.
- **Data Flow:** Every 60 seconds, it feeds OpenRouter data on network congestion (median tips, slot speeds). It caches a `TipStrategy` multiplier.
- **Integration:** When the Core Engine fires a transaction, it instantly reads the cached multiplier and calculates `LiveMedianTip * Multiplier`.

### D. Jito Bundle Submission & Retry Loop
- **Component:** `JitoBundleSender` & `LifecycleTracker`
- **Role:** Bypasses public gossip to submit atomic bundles directly to the Jito Block Engine.
- **Retry Mechanism:** Waits for confirmation via the gRPC stream. If the bundle drops or hits the 45-second blockhash expiry timeout, it enters the Autonomous Retry Loop.

### E. AI Failure Agent (Synchronous Mutation)
- **Component:** `AiFailureAgent`
- **Role:** Fulfills the "Failure Reasoning" AI bounty requirement.
- **Data Flow:** When a transaction fails, exact telemetry (`BlockhashExpired`, `SimulationError`) is passed to the AI.
- **Decision:** The AI evaluates the error. If `SlippageExceeded`, it halts to protect capital. If `BlockhashExpired`, it instructs the retry loop to fetch a new blockhash and increase the tip multiplier.

---

## 3. Failure Handling Strategy

The system classifies failures into specific vectors and handles them deterministically:
1. **Blockhash Expiration:** Detected locally via a 45-second timeout on the confirmation promise. The AI Agent intercepts this, fetches a fresh blockhash via RPC, and resubmits.
2. **Jito Bundle Dropped:** Handled identically to blockhash expiration. The bundle is deemed dropped if not processed within the timeout window.
3. **Simulation/Slippage Errors:** Simulated locally via `TransactionSimulator`. If a hard error occurs, the bot aborts the trade.

---

## 4. Why This Architecture Wins
By completely removing the AI from the *strategy selection* phase, we eliminate the 1-3 second latency of waiting for LLM APIs. By migrating the AI to the *transaction landing* phase, we harness machine learning for what it does best: dynamic pricing (Tip Intelligence) and adaptive fault recovery (Failure Reasoning), ensuring our 0ms algorithmic trades actually land on the blockchain.
