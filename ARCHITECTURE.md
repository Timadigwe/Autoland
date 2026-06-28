# AutoLand Architecture Specification

This document details the architecture, data flows, and recovery strategies implemented in the AutoLand transaction execution stack.

> **Live Specification Page:** This design document is rendered as a premium responsive web application and hosted live at:
> **[AutoLand Live Architecture Specification](https://dazzling-duckanoo-9fcd98.netlify.app/)**

---

## 1. SDK Core Architecture & Reference Integration

AutoLand is built as a reusable, developer-focused **Intelligent Transaction Execution Stack SDK** (`@autoland/core`). 

It is designed to be imported as a library by any Solana application (bots, dApps, backend systems) that requires high-reliability transaction landing under contested network conditions.

The `dlmm-bot` package in this repository serves as a **real-world reference implementation** (tested live on the contested **WORLDCUP/SOL** pool) that demonstrates how to configure and call the AutoLand SDK to manage liquidity on Meteora DLMM pools.

```
┌───────────────────────────────────────────────────────────────────────────────┐
│                           Your Bot / Application                              │
│  - Constructs transactions (e.g. swaps, token launch snipes, DLMM rebalances) │
│  - Registers pool/account addresses for contention tracking                   │
│  - Submits batches to the AutoLand SDK                                         │
└──────────────────────────────────────┬────────────────────────────────────────┘
                                       │ (Submit Transactions / Registers Filters)
                                       ▼
┌───────────────────────────────────────────────────────────────────────────────┐
│                                 AutoLand SDK                                  │
│  - Streams block telemetry, slots, and Jito bundle results                   │
│  - Dynamically updates Yellowstone gRPC filters to trace signatures/contention │
│  - Calculates localized fee rates (outbidding competitors or falling back)    │
│  - Manages retry pipelines, simulations, and RPC fallbacks                    │
│  - Executes AI Advisor diagnostic loops for dropped/failed bundles            │
└───────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Dynamic Fee & Contention Engine

To guarantee block landing during high-congestion periods without overpaying during calm slots, the AutoLand SDK tracks localized contention on registered target accounts/pools in real-time.

```
                              ┌─────────────────────────┐
                              │ Yellowstone gRPC Stream │
                              └────────────┬────────────┘
                                           │ (Pool Transactions)
                                           ▼
                            ┌─────────────────────────────┐
                            │    CompetitorTipTracker     │
                            └──────────────┬──────────────┘
                                           │
                    (Contested)?           ▼
             ┌─────────────────────────────┴─────────────────────────────┐
             │ YES                                                       │ NO
             ▼                                                           ▼
┌──────────────────────────────┐                           ┌──────────────────────────────┐
│  Outbid Pool Competitors     │                           │   Global Jito Percentiles    │
│  - Compute Max Tip/CU rate   │                           │   - Fetch block engine tips  │
│  - Scale tip to target pool  │                           │   - Fallback to p50/p90/p99  │
└────────────┬─────────────────┘                           └─────────────┬────────────────┘
             │                                                           │
             └─────────────────────────────┬─────────────────────────────┘
                                           ▼
                            ┌─────────────────────────────┐
                            │      Dynamic Jito Tip       │
                            └─────────────────────────────┘
```

### A. How Jito Auctions Work
* **Jito Bundle Lock Aggregation**: The Jito Block Engine aggregates the read/write lock requirements of all transactions inside a bundle using its `BundleAccountLocker`. This guarantees atomicity across transactions.
* **Conflict Set Isolation**: Bundles competing for the same write-locks (e.g., multiple bots trying to swap on the same DLMM pool, sniping a new token launch from a Raydium/Pump pool, or executing arbitrage in the same block) are grouped into a single **Conflict Set**.
* **Priority Auction Sorting**: Within each Conflict Set, Jito conducts a local priority auction every block, ranking conflicting bundles by their **Priority Score** (effective tip density):

$$\text{Priority Score} = \frac{\text{Total Tip}}{\sum \text{CUs Requested}}$$

Only the highest-paying bundle in the Conflict Set wins the lock, while the remaining conflicting bundles in that set are dropped.

**Example of outbidding with optimized CUs:**
* **Transaction A (Optimized)**: Requests `50,000 CUs` and pays a `5,000,000 lamport` tip. Its Priority Score is:
  $$\frac{5,000,000}{50,000} = 100 \text{ lamports/CU}$$
* **Transaction B (Default/Unoptimized)**: Requests `1,400,000 CUs` and pays a `70,000,000 lamport` tip. Its Priority Score is:
  $$\frac{70,000,000}{1,400,000} = 50 \text{ lamports/CU}$$

Even though Transaction B pays a **14x higher absolute tip** (70M lamports vs 5M lamports), **Transaction A wins the auction** and lands first because its Priority Score (effective tip density) is **2x higher** than Transaction B's. This allows highly optimized transactions to consistently outbid competitor bots at a fraction of the cost.

### B. Our Approach: Tracking Contention & Competition for an Account
Because Jito auctions happen off-chain and resolve block-by-block, global Jito tip APIs are too generic and lag behind localized bidding wars on active accounts. We solve this by tracking competition directly on the registered account:
* **gRPC Account Streaming**: Through Yellowstone gRPC, the SDK streams all transactions writing to the registered account filter (`accountInclude` filters).
* **Competitor Tip Profiling (`CompetitorTipTracker`)**: Parses transaction structures to extract Jito tips paid and CUs requested, computing the active **Competitor Tip/CU** rate for that account's lock budget.
* **Dual-Tiered Bidding Logic**:
  - **Contested State (Fee War)**: If active competition is detected on the account, the SDK dynamically scales its tip to outbid the competitor's active rate:
    $$\text{Target Tip} = \text{Competitor Tip/CU} \times \text{Transaction CUs} \times \text{Outbid Multiplier}$$
  - **Uncontested State (Normal/Calm)**: If the account is quiet, the tip calculation automatically defaults back to global Jito fee percentiles (p50/p90/p99) to prevent overpaying.

This strategy was tested on the live **WORLDCUP/SOL** pool during high-volume trading phases, allowing transactions to land successfully block-by-block while reducing fee spend by up to 60% compared to static p99 tipping.

---

## 3. Compute Unit (CU) Resizing Optimization

### The Priority Score Denominator
If a developer builds a transaction requesting the default `1,400,000` CUs but the transaction execution only consumes `50,000` CUs, the effective Priority Score is reduced by **28x**. Jito is highly likely to drop this bundle in favor of smaller, higher-density competitor bundles.

AutoLand solves this by integrating an automated **CU Resizing Optimization Pipeline**:

```
┌────────────────────────┐      ┌────────────────────────┐      ┌────────────────────────┐
│  Compile Transactions  │ ───► │ Simulate Bundle (RPC)  │ ───► │  Parse CU Consumption  │
└────────────────────────┘      └────────────────────────┘      └───────────┬────────────┘
                                                                            │
                                                                            ▼
┌────────────────────────┐      ┌────────────────────────┐      ┌────────────────────────┐
│  Build & Sign Bundle   │ ◄─── │ Re-size CU Instruction │ ◄─── │  Add 10% safety margin │
└────────────────────────┘      └────────────────────────┘      └────────────────────────┘
```

1. **Pre-Flight Simulation**: The SDK intercepts transaction batches and submits them to the RPC's `simulateTransaction`/`simulateBundle` interfaces on the active network state.
2. **Parsing & Extraction**: It extracts the exact number of Compute Units consumed by each instruction.
3. **Safety Margin Injection**: Adds a 10% safety margin to accommodate any state changes between simulation and landing.
4. **Instruction Update**: Replaces the default `SetComputeLimit` instructions in the transactions with the optimized limits.
5. **Re-signing & Dispatch**: Re-signs the modified transaction batch and submits it to Jito.

This dynamic resizing minimizes the denominator, maximizes the Priority Score, and allows our bundle to win Jito Conflict Set auctions at a fraction of the cost.

---

## 4. The Autonomous AI Recovery Stack

When transaction submission fails or drops, the AutoLand SDK routes incidents to an LLM-powered recovery agent backed by strict program constraints. Because the advisor executes on retry and refreshes the transaction blockhash before resubmitting, we can trade off a small amount of inference latency. This allows the stack to remain compatible with any fast inference engine (such as Groq, OpenRouter, or custom LLM providers).

### A. Failure Classification & Routing
* **Deterministic Shortcut (High Confidence)**: Stale blockhashes or specific program errors are handled instantly using pre-programmed rules (e.g. immediate retry with a fresh blockhash).
* **AI Diagnostic Loop (Low/Medium Confidence)**: Unknown rejections, compute limit overruns, simulation errors, or Jito drops are routed to the **AI Advisor** (configured via LLM API).

### B. Advisor Diagnostics Tools
The AI Advisor invokes read-only diagnostic tools in the workspace to retrieve context:
* `read_lifecycle_events`: Inspects the transaction lifecycle trace (submitted slots, landing slots, drops).
* `read_simulation_logs`: Examines detailed instruction simulation logs returned by `simulateBundle`.
* `get_tip_market_stats`: Looks up current recommended tips versus what was paid.
* `read_session_memory`: Tracks the history of retries and mutations applied *during this rebalance session* to prevent repeating failed actions.
* `read_log_tail`: Inspects recent debug logs from the bot strategy and transaction dispatcher.

### C. Safety Guardrails (Hard Code-Enforced)
To prevent model hallucinations from causing financial loss, the advisor's suggested decisions are processed through strict, non-bypassable constraints:
* **Absolute Tip Caps**: Bumps are capped at a hard limit (`JITO_MAX_TIP_LAMPORTS`).
* **Slippage Caps**: Bumps to strategy slippage are restricted by `AI_MAX_SLIPPAGE_BPS_CAP`.
* **Action Restrictions**: The model cannot increase tips for simulation failures caused by logic/slippage errors (which would only waste money).
* **Halt Thresholds**: Automatically Halts the strategy if maximum retries are exhausted.

---

## 5. Submission & Confirmation Pipelines

### A. Jito-First Dispatch & Leader Window Detection
* Transaction submission is restricted to Jito bundles to prevent toxic frontrunning or trade slippage.
* Bundles are sent sequentially to regional Jito block engines (e.g., Frankfurt, NY, Tokyo) to minimize latency and stopped as soon as the bundle is accepted.
* **Leader Window Alignment**: AutoLand uses a real-time **Yellowstone gRPC** stream to monitor live slot progress and leader schedule transitions. It dynamically calculates the distance to the next Jito-enabled validator, ensuring bundles are submitted exactly within the optimal leader execution window.

### B. Multi-Stage Lifecycle & Dual-Channel Confirmation
To guarantee landing accuracy, the SDK implements a dual-channel confirmation pipeline. It tracks the transaction through every lifecycle stage: **Submitted → Processed → Confirmed → Finalized**, capturing:
* **Timestamps** at each transition.
* **Slot numbers** representing the exact execution sequence.
* **Latency deltas** between stages to monitor network consensus performance.

Confirmations are tracked simultaneously via:
1. **Yellowstone gRPC Stream**: Dynamically registers signature status tracking filters inside the Yellowstone subscription to catch processed transactions at sub-second speeds.
2. **RPC Polling Fallback**: Periodically queries `getSignatureStatuses` directly from the RPC nodes as a backup.
3. **Jito Bundle Results gRPC Stream**: Subscribes to Jito's streaming `SubscribeBundleResults` API to immediately catch validator-level rejections (simulation failure, bid rejected) and fail fast, triggering the AI retry loop instantly instead of waiting for a timeout.

If a transaction fails to progress, the system classifies the exact failure:
* **Expired Blockhash**: Blockhash exceeded the 150-slot TTL window.
* **Fee Too Low**: Jito auction floor/tip density not met.
* **Compute Exceeded**: Transaction exceeded the allocated compute limits.
* **Bundle Failure**: Validator dropped the Jito bundle (e.g. leader skip or simulation error).
