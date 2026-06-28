# AutoLand: Intelligent Solana Transaction Execution Stack

AutoLand is an **Intelligent Transaction Execution Stack SDK** for Solana. It is built to ensure hyper-reliable, cost-effective transaction landing on highly contested block space, utilizing Jito bundles, Yellowstone gRPC streams, and autonomous AI-driven recovery.

The `dlmm-bot` included in this repository is a **real-world reference implementation** (tested live on the contested **WORLDCUP/SOL** pool) demonstrating how developers can import and use the AutoLand SDK for complex, real-time trading actions on Meteora DLMM pools.

> **Architecture & System Design Document:** The system architecture, core pipelines, and infrastructure decisions are hosted publicly here:
> **[AutoLand Architecture & System Design Document](https://dazzling-duckanoo-9fcd98.netlify.app/)**

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

### 5. Leader Window Detection & Real-Time Telemetry
AutoLand uses a real-time **Yellowstone gRPC** stream to monitor live slot progress and leader schedule transitions. It dynamically calculates the distance to the next Jito-enabled validator, ensuring bundles are submitted exactly within the optimal leader execution window.

### 6. Multi-Stage Lifecycle & Dual-Channel Confirmation
To guarantee landing accuracy, the SDK implements a dual-channel confirmation pipeline. It tracks the transaction through every lifecycle stage: **Submitted → Processed → Confirmed → Finalized**, capturing:
* **Timestamps** at each transition.
* **Slot numbers** representing the exact execution sequence.
* **Latency deltas** between stages to monitor network consensus performance.

If a transaction fails to progress, the system classifies the exact failure:
* **Expired Blockhash**: Blockhash exceeded the 150-slot TTL window.
* **Fee Too Low**: Jito auction floor/tip density not met.
* **Compute Exceeded**: Transaction exceeded the allocated compute limits.
* **Bundle Failure**: Validator dropped the Jito bundle (e.g. leader skip or simulation error).

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

## Submissions & Operational Findings

All entries in [lifecycle.jsonl](./logs/lifecycle.jsonl) represent **real Jito bundle submissions** and **AI recovery flows** executed on-chain by wallet `8CifBx1MK2Z6CWME6mY8BKg54uXj7Dge2Ux3Y2zNcGtn` and verified via Solscan. 

| Entry | Status | Bundle ID | Jito Tip | Operation | Signatures & Solscan Links |
|---|---|---|---|---|---|
| Entry 01 | 🟢 FINALIZED | `82de89b4...449fefc4` | 6,851,610 lamports | Meteora Remove Liquidity & Meteora Add Liquidity & Other | [3s48Pttt...2VBHnbsZ](https://solscan.io/tx/3s48PtttU1wuBu3msbq8WABBDsViEcAiCypswfH8nLcd3NiJ9eosSbNm7AxbAEiooKqPKB1T4BQHizkZ2VBHnbsZ)<br>[4NKTCrZe...Up7m3jmY](https://solscan.io/tx/4NKTCrZeXNc3zAWn8s1f7LaxPDkgbiAWuto9QiiqYwyK4i7oBfsLjsvSADxbCmHsPskdvPJL4LBDjkyKUp7m3jmY)<br>[4pa2FYcg...JGbLra5e](https://solscan.io/tx/4pa2FYcgAcM4pQTGtAYFgpksN86U5LEJvoSrKs2BrNKui6vL7ik5ae3oue952EHm7Zx95KrMx2wtBZNpJGbLra5e) |
| Entry 02 | 🟢 FINALIZED (Recovered) | `4858d237...949a22ef` | 15,000 lamports | Meteora Remove Liquidity | [5tNGQ1tz...hphAPqxC](https://solscan.io/tx/5tNGQ1tzy3BTwx7rG3qyXQeK5a5jDqMuDXTRS4cYktUzWiXMYGcSAaNmPxwqJdDTvviLWk678sXryGvphphAPqxC) |
| Entry 03 | 🟢 FINALIZED | `96b8c42c...c8337146` | 11,588,776 lamports | Meteora Remove Liquidity & Other & Meteora Add Liquidity | [2FLUzdtG...PVR6mHCY](https://solscan.io/tx/2FLUzdtGxE7EVcgDHAWtsn2ziTu6EYTNg6p2hEKZbqacog39uBd1xTRrLivepGdRe1BnBCwgzCksQYFtPVR6mHCY)<br>[54r4SoHm...cyESFPCP](https://solscan.io/tx/54r4SoHmybzaqzAjbHkKq8tLQSXrnJeQLBsQPbtErZmptJH6NLkrgaseksjvvejQEJrqJaBiq7rnKEtecyESFPCP)<br>[5tte7g5h...oGyHP8kS](https://solscan.io/tx/5tte7g5hmrXnPSVJTxVo6aMa68cap1SdPgJddJ4d3BGJUnno8xMzKisANiBaL7eMeZKTPJoA4sGEMvrZoGyHP8kS) |
| Entry 04 | 🟢 FINALIZED (Recovered) | `88759dd8...5a1c2b04` | 15,000 lamports | Meteora Remove Liquidity & Meteora Add Liquidity | [3LenJ49M...gj85zaDj](https://solscan.io/tx/3LenJ49MV9BWfooPPFyGGqiQWvfveAuJz419vpq9TLnnaGSJ3p5jqnUvFhtU6KVihaDi9Ab3s5atqZKugj85zaDj)<br>[5VtctK5Q...J9J7XEzL](https://solscan.io/tx/5VtctK5QfNMGS5Qf4ncPRpBv97hyVRjBMzruSfFK3FAacxkjcxEnEGD53RgYWF6KAUQfJ5itNKZzXrvTJ9J7XEzL) |
| Entry 05 | 🟢 FINALIZED (Recovered) | `143efc2f...d3a968cb` | 15,000,000 lamports | Meteora Remove Liquidity & Meteora Add Liquidity & Other | [4NuJjjK3...ZnCz311G](https://solscan.io/tx/4NuJjjK3wMbDN2zmUabSdi7d6cCPkKgH2KYbitFKdsQ9Wh9AqZTjCT7dUmjeDvJVkVtx6SDbNNegRnKHZnCz311G)<br>[4p1YkwxP...4WWsM3f4](https://solscan.io/tx/4p1YkwxPcQtpkEy9eNZ8mRonBrDhbKDEm3hw2NGAeZu5Gb25MtJtXe36A2Cak23kFq98b1U9UQZYMLaF4WWsM3f4)<br>[5zjwZtKx...WEbgPFUM](https://solscan.io/tx/5zjwZtKxxTXriqxvPLpqL18N5p6GFDPdKbHCkZtidnKjhnyHjMDNF7Yw3HZQfRdL8ykYFnR4zAvzAqd3WEbgPFUM) |
| Entry 06 | 🟢 FINALIZED | `308f6e96...6a3c5082` | 10,375,682 lamports | Meteora Remove Liquidity & Other & Meteora Add Liquidity | [279GEZTK...H7oSQ2x9](https://solscan.io/tx/279GEZTKT4crCNPj4FzjNNYwQzZXPpvREEiBN8vmfEMFK2osd7YQqLosv1kbscSizRjgFLh4Zo5Ad12vH7oSQ2x9)<br>[2ZRTL6Zt...jH3VVtRG](https://solscan.io/tx/2ZRTL6ZtqeQG6sD2tW8dH42NB35bjDFtn12GrpfkBcHSsco2Yx8TZDhJax4f2gWaUFVXESDqrXSYJMJrjH3VVtRG)<br>[sa51npZv...5AmmL55X](https://solscan.io/tx/sa51npZvQfpwvQwF8Q8MeShKnXa6E9DZ1F4ogUJQ6norUhXNBz26tfqzU4gH8X6djQWNH1hwEueWEfe5AmmL55X) |
| Entry 07 | 🟢 FINALIZED | `1c8d08b7...c81d2ad8` | 10,417,111 lamports | Meteora Remove Liquidity & Other & Meteora Add Liquidity | [3wcVJPRR...V5D1Nshk](https://solscan.io/tx/3wcVJPRR3sty4m8ZqbvaJ1SEh6HLUyPGYmjdeZ8v5mA2NjHAoJfSYN7kVD8piYn3nXPFvrskjX9nWkZxV5D1Nshk)<br>[4Zeax1DQ...cAiCbv1u](https://solscan.io/tx/4Zeax1DQVYQnumee23rWppV1PxQ2WUjceHExZzUwYqcaeLNDiz93ZDnAX4UYf1B9DwPuw27NTGW7v7BQcAiCbv1u)<br>[UWKJ6T2m...QNzgzi7u](https://solscan.io/tx/UWKJ6T2mHukPpPR9cW3hzubtYGdTgjWFqHoXSQYe9NcuCGByS4rw718NWxj8JdYJ3fHLfAPvgkfDctaQNzgzi7u) |
| Entry 08 | 🟢 FINALIZED | `5f35b7cd...d2553ae0` | 10,963,089 lamports | Meteora Remove Liquidity & Other & Meteora Add Liquidity | [2Z59PQ5U...nEoKaeJq](https://solscan.io/tx/2Z59PQ5UxuuzeyQjHQ3yTYAogxGzi6nidQjXv5sUtFiGYJPcZGReP3tEL7D6yoY3ZRqxqR71shzey2BnEoKaeJq)<br>[3e6gSbWn...kkRmr1wf](https://solscan.io/tx/3e6gSbWn6xmnY4mW62YBWVgVpDhbcUfXZ2KMiXVhagtK1NhedKX18TZWj5BoZZtnKNW889v4YKi2kueZkkRmr1wf)<br>[Uyh8o5cA...geoBHifC](https://solscan.io/tx/Uyh8o5cANS81tHK5huMexzycamZhHSGcKauwzdcc3q7VkmmBtvhhYxnb8364k6zTYfbxCrCDrWFEshdgeoBHifC) |
| Entry 09 | 🟢 FINALIZED | `3bfbb722...f895c247` | 6,052,744 lamports | Meteora Remove Liquidity & Other & Meteora Add Liquidity | [2PDtiALf...saGkiiVm](https://solscan.io/tx/2PDtiALfQYC4xCLgS3Yzp53REaP7RuTQwPLDazfueX7jvqkgySioJdhdTx1K2hmWosm2trnwiJzajECRsaGkiiVm)<br>[2fKXZA4r...f32V379i](https://solscan.io/tx/2fKXZA4rPRqP5yNanuwF3sapnYi8Y5EK1TSSVUVHCqZvFjCtXhuHexxvQmwgxk254Fp1m9DvhtuGpXtEf32V379i)<br>[539jhaoR...ZejyUuGa](https://solscan.io/tx/539jhaoRW4DkFMSSmyLFMwxcDrysZf242EK7YZXHbegcL22WseSz8u83rWTVoKBHsKVt5HbUBZBwT3G2ZejyUuGa) |
| Entry 10 | 🟢 FINALIZED | `3bad93b2...bc9367a1` | 6,503,220 lamports | Meteora Remove Liquidity & Meteora Add Liquidity & Other | [3FU6dfHx...D2zjokB6](https://solscan.io/tx/3FU6dfHxePAif4HGqR5pNc3578iGbM78oUCCVjQSo6s5dP2iF4efERjKvJfo6yQC8nFZxy6EQEC7goipD2zjokB6)<br>[3JFnUdi8...K1GASqGG](https://solscan.io/tx/3JFnUdi8bGEKQp5mp2nzNjsUXQb6jCGnTGvrcjTEUJxeKjCtYh1Gv3RQPGC8xuAeLoKnpNyp1QhF4PcvK1GASqGG)<br>[4K2ei2eZ...BBCugjib](https://solscan.io/tx/4K2ei2eZtURL1Hk9TSvWhG3LbVz4wRN9kQDrs3QEJdTdp9vESpLPjb9tZe4SGVGx1neyFuKnW1DKPJJBBBCugjib) |

---

## README Questions & Operational Insights

### Question 1: What does the delta between `processed_at` and `confirmed_at` tell you about network health at the time of submission?

The delta between the slot's `processed` timestamp (when the block leader executes the transaction and applies state mutations) and the `confirmed` timestamp (when $2/3$+ of Solana validator voting stake has signed off on the block) acts as a real-time monitor of **consensus health**.

* **Optimal Network State**: Under normal execution conditions, this delta is between **400–800 ms** (which represents a delay of 1 to 2 slots).
* **Degraded Network State**: If this delta spikes to several seconds, it signals validator vote propagation bottlenecks. This is usually caused by excessive voting transaction congestion on the network, validator hardware processing backlogs, or micro-forking.
* **SDK Monitoring**: AutoLand tracks these latency patterns via its `CongestionOracle` to scale safety delays and determine when to defer submissions.

### Question 2: Why should you never use `finalized` commitment when fetching a blockhash for a time-sensitive transaction?

Solana blockhashes are valid for exactly **150 slots** (representing roughly 60 seconds of real-world time at a standard 400ms block time). 

* **Finalization Lag**: Achieving `finalized` commitment requires a block to be confirmed by supermajority voting and buried under 32+ subsequent slots (`MAX_LOCKOUT_HISTORY`). This process takes roughly **13 to 15 seconds**.
* **Validity Loss**: If you fetch a blockhash at `finalized` commitment, it is already 13–15 seconds old by the time the SDK receives it. You have effectively burned **20% to 25% of the transaction's lifetime** before it is even signed.
* **Staleness Risk**: During high congestion, block times stretch. A finalized blockhash is highly likely to expire before it reaches the leader's TPU forwarding pipeline, triggering a `Blockhash not found` rejection.
* **AutoLand Best Practice**: The SDK always queries the latest blockhash at **`confirmed`** commitment, maximizing the transaction's window of validity.

### Question 3: What happens to your bundle if the Jito leader skips their slot?

If the scheduled Jito leader misses or skips their slot (e.g. due to validator crash, hardware latency, or micro-forking):

* **The Bundle is Dropped**: Jito bundles are not gossiped across Solana's public P2P mempool. Instead, they are routed off-chain to Jito's Block Engine, which forwards them *only* to the specific validator scheduled for that slot. If that leader skips their slot, the engine drops the bundle.
* **SDK Mitigation**:
  1. **Leader Window Alignment**: AutoLand tracks scheduled leaders via its `LeaderWindowDetector` and holds execution if the leader distance slots are unfavorable.
  2. **Multi-Region Dispatch**: Dispatches bundles in parallel to multiple regional Jito block engines (Frankfurt, NY, Tokyo) to minimize routing drops.
  3. **Autonomous AI Retry**: If the Jito results stream (`onBundleResult`) indicates a drop or slot skip, the AI Advisor detects the failure, pulls a fresh blockhash, and submits a modified bundle to the next scheduled window.

---

## License

MIT
