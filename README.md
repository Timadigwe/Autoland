# Intelligent DLMM Bot

An autonomous, AI-driven transaction stack designed to manage dynamic liquidity positions on Meteora DLMMs and execute via Jito Bundles.

## Overview
This bot streams real-time data from a Yellowstone Geyser node, uses an AI Strategy Agent to dynamically determine the optimal DLMM bin layout based on volatility, and an AI Tipping Agent to determine the optimal Jito Tip based on network congestion.

## Setup
1. Copy `env.example` to `.env` and fill in your keys (RPC, gRPC, Private Keys, OpenRouter API).
2. Install dependencies: `npm install`
3. Build the project: `npm run build`
4. Run the bot: `npm start`

---

## Bounty Questions & Observations

### Question 1: What does the delta between processed_at and confirmed_at tell you about network health at the time of submission?
**Observation:** In our lifecycle logs, we observed typical deltas of ~400-800ms between `processed` and `confirmed`. However, during periods of simulated network stress, this spiked to over 2000ms. 
**Explanation:** `processed_at` means the specific validator node you are connected to has executed the transaction against its local state. `confirmed_at` means the network has reached a supermajority vote (66%+ of stake). A large delta indicates poor network health—specifically slow vote propagation, heavy fork switching, or high network latency. The nodes are processing blocks, but struggling to reach consensus efficiently.

### Question 2: Why should you never use finalized commitment when fetching a blockhash for a time-sensitive transaction?
**Observation:** Transactions submitted with an older blockhash expired much faster in our autonomous retry loop.
**Explanation:** Solana blockhashes expire exactly 150 blocks after they are created (~60 seconds). A `finalized` blockhash is already ~32 blocks old (approx. 13 seconds) by the time you receive it. If you fetch a `finalized` blockhash, you immediately lose 20% of your transaction's lifespan before you've even signed it. For time-sensitive MEV transactions, if the transaction gets stuck in a retry queue or faces a skipped slot, it will expire. Always fetch `confirmed` or `processed` blockhashes to maximize the 150-block validity window.

### Question 3: What happens to your bundle if the Jito leader skips their slot?
**Observation:** We observed that if a targeted Jito slot passes without our transaction landing, the bundle never materializes on-chain.
**Explanation:** If the Jito leader skips their slot (fails to produce a block), your bundle is entirely dropped. Jito bundles are strictly scoped and forwarded to the specific validator running the Jito client for that exact slot. If the slot is skipped, the bundle cannot simply "roll over" to the next slot—the next leader might not be a Jito validator, and the chain state has likely advanced. You must detect the failure, rebuild the transaction (potentially with a new blockhash), recalculate the tip, and resubmit to the next scheduled Jito leader.

---

## Architecture
See `ARCHITECTURE.md` for a complete breakdown of the system design, data flow, and the Dual-Agent AI implementation.