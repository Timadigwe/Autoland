# Intelligent DLMM Market Maker

A high-performance, asynchronous market-making stack built for the Solana Transaction Infrastructure Bounty. This bot natively automates liquidity management on Meteora DLMM using a 0ms-latency fixed-distance execution engine, backed by an AI-driven transaction landing stack.

## System Architecture
Please review the [Architecture Design Document](./ARCHITECTURE.md) for a complete breakdown of the system's data ingestion, core engine logic, and AI integration.

### Core Features
- **Yellowstone gRPC Stream**: Real-time slot, transaction, and account updates.
- **DLMM Engine**: Fixed-distance drift threshold for zero-latency Swapless Rebalancing.
- **Jito Bundle Injection**: Bypasses public gossip for immediate block-engine submission.
- **Tip Intelligence Agent (AI)**: Asynchronous background loop that calculates Tip Multipliers based on real-time network congestion.
- **Failure Reasoning Agent (AI)**: Synchronous loop that intercepts dropped or failed bundles, dynamically mutating the payload (e.g. refreshing blockhashes) for autonomous retries.

## Quickstart
1. Set up `.env` with `JITO_AUTH_TOKEN`, `OPENROUTER_API_KEY`, and `PRIVATE_KEY`.
2. `npm install`
3. `npm run build`
4. `npm start`
*Note: Press 'F' while the bot is running to intentionally inject an expired blockhash, triggering the AI Failure Reasoning autonomous retry loop.*

---

## Bounty Questions & Network Observations

### Question 1: What does the delta between processed_at and confirmed_at tell you about network health at the time of submission?
The delta between `processed` (the moment the leader processes the transaction into a block) and `confirmed` (the moment 66%+ of validators have voted on that block) is the ultimate metric for measuring **propagation latency and consensus health**. 
During our telemetry gathering, a healthy network exhibited a delta of roughly 400-800ms. If this delta begins expanding to multiple seconds, it indicates severe TPU congestion, significant vote delays, or minor forks causing validators to struggle to reach supermajority consensus. For high-frequency trading, expanding deltas are a leading indicator that you must increase your Compute Unit Price to ensure priority inclusion in subsequent blocks.

### Question 2: Why should you never use finalized commitment when fetching a blockhash for a time-sensitive transaction?
On Solana, a blockhash is only valid for exactly 150 slots (roughly 60 seconds). A `finalized` block is typically ~31 blocks (about 12 seconds) behind the current live chain tip. If you fetch a `finalized` blockhash for a time-sensitive transaction, you are artificially burning 20% of your transaction's lifespan before you even submit it! For MEV bundles or DLMM rebalances where every millisecond counts against the Jito Block Engine's auction window, you must always fetch a `confirmed` or `processed` blockhash to maximize your transaction's validity window across potential retries.

### Question 3: What happens to your bundle if the Jito leader skips their slot?
If you submit a bundle to the Jito Block Engine and the designated leader skips their slot (due to network partitions, being offline, or a fork), your bundle is not immediately dead, but it **fails to land in that specific block**. 
However, the Jito Block Engine operates as a specialized mempool. It will hold your bundle and automatically re-auction it to the *next* available Jito leader. The true danger here is the blockhash. If the Block Engine holds the bundle for too long across multiple skipped slots, the blockhash will expire, and the transaction will be permanently dropped. This is exactly why our architecture includes an AI Failure Agent that intercepts these timeouts, refreshes the blockhash, and submits an autonomous retry.