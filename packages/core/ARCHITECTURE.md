# AutoLand Architecture Design

## Core Architecture
AutoLand follows a modular design, split into distinct sub-systems that operate concurrently to manage transaction lifecycles safely on Solana.

### Key Components

1. **Stream Manager (`src/stream`)**
   - Connects to Yellowstone gRPC to listen for slot and transaction events.
   - Responsible for backpressure management and ensuring no stale events are processed.

2. **Network Oracle (`src/network`)**
   - **Congestion Oracle**: Evaluates the processed-to-confirmed delta.
   - **Leader Window Detector**: Reads the leader schedule to ensure bundles are only broadcast when `inSubmitWindow` is true for a Jito leader.

3. **Bundle Submitter (`src/bundle`)**
   - Compiles Jito bundles dynamically.
   - **Critical Mechanism**: Explicitly awaits the exact `submit_at_slot` requested by the AI agent and guarantees submission only occurs when the Jito leader window is open.

4. **Lifecycle Tracker (`src/lifecycle` & `src/db`)**
   - Tracks the 4 stages of commitment: Submitted → Processed → Confirmed → Finalized.
   - Logs every stage timestamp, slot, and AI decision directly to a SQLite database (`autoland.db`) to ensure immutable, queryable operational records.

5. **AI Agent (`src/agent`)**
   - Connects to a local vLLM instance running `Qwen 2.5 7B`.
   - Receives JSON context upon bundle failure (e.g., `AuctionDropped`, `BlockhashExpired`) and returns a strict-JSON retry decision (`RETRY`, `HOLD`, or `ABORT`).

## Data Flow
1. Developer calls `AutoLand.submit(tx)`.
2. `BundleBuilder` fetches `tip_floor` and scales the urgency percentile dynamically using a combination of Base-Layer Congestion (latency/skips), Financial Volatility Spread (p95/EMA), MEV Momentum, and the Local Bundle Drop Rate.
3. System pauses until `inSubmitWindow` matches the target slot.
4. Bundle is broadcast to Jito Block Engine.
5. `StreamManager` receives `processed` and `confirmed` events, updating the SQLite DB.
6. If the transaction drops, `FailureClassifier` packages the evidence.
7. `Agent` (Qwen 2.5) processes the evidence, enforces tip guardrails, and dictates the retry parameters.
