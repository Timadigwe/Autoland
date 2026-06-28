# AutoLand: Intelligent Solana Transaction Execution Stack

AutoLand is an **Intelligent Transaction Execution Stack SDK** for Solana. It is built to ensure hyper-reliable, cost-effective transaction landing on highly contested block space, utilizing Jito bundles, Yellowstone gRPC streams, and autonomous AI-driven recovery.

The `dlmm-bot` included in this repository is a **real-world reference implementation** (tested live on the contested **WORLDCUP/SOL** pool) demonstrating how developers can import and use the AutoLand SDK for complex, real-time trading actions on Meteora DLMM pools.

---

## Technical Context: How the Jito Auction Engine Works

To land transactions reliably on contested accounts (such as a popular DLMM pool, a newly launched token mint, a liquidations state, or a high-demand NFT mint), you must understand the Jito Block Engine's off-chain auction and bundle selection process:

1. **Jito's Bundle Account Locking**:
   When Jito receives a bundle of transactions, the Block Engine aggregates the read/write accounts required by all transactions in that bundle using its `BundleAccountLocker`. These accounts are locked for the duration of the bundle's execution to guarantee state atomicity and prevent race conditions.
2. **Conflict Set Grouping**:
   If multiple bundles require write-locks on overlapping accounts (such as multiple bots trying to swap on the same DLMM pool, buy a newly launched token from a raydium/pump pool, or execute arbitrage in the same block), Jito isolates them into a single **Conflict Set**.
3. **The Priority Auction & Bundle Ranking**:
   Since only one bundle in a conflict set can lock the account at a time, Jito runs a localized priority auction for each conflict set every block. Jito ranks the conflicting bundles based on their **Priority Score** (effective tip density):
   
   $$\text{Priority Score} = \frac{\text{Total Tip}}{\sum \text{CUs Requested}}$$
   
   The validator packs the bundle with the highest Priority Score first, dropping the remaining lower-paying conflicting bundles from that set.

    **Example of outbidding with optimized CUs:**
    * **Transaction A (Optimized)**: Requests `50,000 CUs` and pays a `5,000,000 lamport` tip. Its Priority Score is:
      $$\frac{5,000,000}{50,000} = 100 \text{ lamports/CU}$$
    * **Transaction B (Default/Unoptimized)**: Requests `1,400,000 CUs` and pays a `70,000,000 lamport` tip. Its Priority Score is:
      $$\frac{70,000,000}{1,400,000} = 50 \text{ lamports/CU}$$
    
    Even though Transaction B pays a **14x higher absolute tip** (70M lamports vs 5M lamports), **Transaction A wins the auction** and lands first because its Priority Score (effective tip density) is **2x higher** than Transaction B's. This allows highly optimized transactions to consistently outbid competitor bots at a fraction of the cost.

---

## Our Approach: Tracking Contention and Competition for an Account

Because Jito's auctions happen in real-time block-by-block, global Jito tip estimation APIs are too generic and slow to react to localized bidding wars on specific accounts. 

AutoLand solves this by tracking the localized contention and competition *for a specific account* dynamically:

### 1. Dynamic Account Competition Tracking
* **Live Yellowstone gRPC Stream**: AutoLand subscribes to a live Yellowstone gRPC transaction stream filtering specifically for the target account (e.g. DLMM pools, token launch mints, or liquidation accounts).
* **Competitor Tip Profiling**: The stream manager decodes every competitor transaction writing to that account in real-time, parsing their Jito tips and CUs to extract the active **Competitor Tip/CU** rate for that account's lock budget.
* **Dual-Tiered Bidding**:
  - **High Contention**: If competitors are actively writing to the account, the SDK dynamically scales its tip to outbid the competitor's active `Tip/CU` rate.
  - **Zero Contention**: If the account is quiet, the tip calculation automatically defaults back to global Jito fee percentiles (p50/p90) to prevent overpaying.

### 2. Compute Unit (CU) Resizing Optimization
To maximize our Priority Score in Jito's conflict set auction, we must minimize the CUs requested (the denominator). AutoLand performs pre-flight local simulations of the transaction batch on the exact network state, calculates the *exact* CUs consumed, and resizes the transaction limit (plus a minimal safety margin). This maximizes our effective Tip/CU density, ensuring validator selection at a minimal tip cost.

During live testing on the highly contested **WORLDCUP/SOL** pool, transactions requesting default CUs were consistently dropped due to conflict set drops and low tip density. AutoLand's dynamic account contention tracking paired with precise CU resizing enabled transactions to land block-by-block while reducing fee spend by up to 60%.

---

## Core Features & Core Solutions

### 1. Optimized Compute Unit (CU) Resizing
AutoLand simulates transaction batches locally before submission to calculate the *precise* CUs consumed. It then resizes the transaction's CU request to match this consumption (plus a minimal safety margin). This keeps the denominator (CU) as small as possible, boosting the effective Tip/CU density and securing Jito validator space at a fraction of the cost.

### 2. Dynamic Contention & Competitor Bidding
AutoLand monitors localized pool/account activity in real-time:
* **Yellowstone gRPC Pool Streaming**: Subscribes to a live Yellowstone stream filtering for all transactions interacting with the target pool or account.
* **Competitor Tip Analysis**: Dynamically decodes competitor transactions' Jito tips and Compute Units (CU) to calculate active `Tip/CU` rates in real-time.
* **Aggressive Outbidding**: During **high pool/account contention** (e.g. high-frequency competitor trades), AutoLand scales its tips to outbid competitors, securing validator priority.
* **Cost-Efficient Fallback**: When **contention is low** (the pool or account is quiet), the tip calculation automatically defaults back to global Jito fee percentiles (p50/p90) to conserve fee budget.

### 3. Jito-First Bundling
Groups related transactions into atomic, in-order bundles submitted directly to Jito validators to bypass public mempool sandwiching and frontrunning.

### 4. Autonomous AI Advisor
A closed-loop transaction recovery system (compatible with any fast LLM inference endpoint) that analyzes landing failures (simulation errors, Jito drops, timeouts) using read-only diagnostic tools, applying mutations (tipping escalations, blockhash refreshes, slippage modifications) within hard safety guardrails. Because the advisor executes on retry and refreshes the transaction blockhash before resubmitting, inference latency does not risk blockhash expiration.

---

## Repository Structure

The workspace is split into two packages:

```
Autoland/
├── packages/
│   ├── core/                    # AutoLand SDK (The core library package)
│   │   ├── src/
│   │   │   ├── dispatch/        # Jito submitters, RPC fallbacks, BundleDispatcher
│   │   │   ├── monitor/         # Yellowstone gRPC integration, competitor tip trackers
│   │   │   ├── recovery/        # AI advisor, diagnostic tools, LifecycleTracker
│   │   │   └── sdk/             # SDK entry point (client.ts)
│   └── bots/
│       └── dlmm-bot/            # Reference implementation (Meteora DLMM maker bot)
└── ARCHITECTURE.md              # In-depth architectural details and specifications
```

---

## The Reference Implementation (`dlmm-bot`)

The `dlmm-bot` package is an example application showing how to integrate `@autoland/core`. It:
* Initializes the `AutoLand` client instance.
* Spins up a concentrated liquidity position strategy on Meteora DLMM.
* Dynamically registers the target pool address (tested on **WORLDCUP/SOL**) to track localized fee contention via the SDK.
* Dynamically tracks its trading wallets via Yellowstone gRPC through the SDK.
* Wraps its position deposits, withdrawals, and rebalances in AutoLand transactions, delegating landing confirmation and AI-driven recovery to the SDK.

---

## Quickstart

### Prerequisites
* Node.js v18+
* Solana RPC endpoint and a Yellowstone gRPC stream URL (with X-Token header)
* OpenRouter, Groq, or compatible LLM provider API key
 
### Setup
1. Copy `env.example` to `.env` in the root workspace and configure:
   ```env
   RPC_URL=https://your-solana-rpc.com
   GRPC_URL=https://your-yellowstone-grpc.com:443
   X_TOKEN=your_grpc_token
   AI_MODEL=openai/gpt-4o-mini # Or meta-llama/llama-3.1-8b-instruct, mixtral-8x7b, etc.
   OPENROUTER_API_KEY=your_llm_provider_api_key
   PRIVATE_KEYS=["your_trading_wallet_private_key"]
   DLMM_TARGET_POOL=your_target_pool_address
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Build the SDK and the bot:
   ```bash
   npm run build
   ```
4. Run the reference bot:
   ```bash
   npm start
   ```

### Simulation / Testing
Press **`f`** at runtime in the bot console to toggle a Jito low-fee injection test. This forces a low Jito tip (e.g. 1000 lamports), prompting Jito drops and allowing you to observe the AutoLand SDK detect the drop, invoke the AI Advisor for recovery diagnostics, and submit a corrected retry bundle.

---

## License

MIT
