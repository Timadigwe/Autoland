# Transaction Simulation Feature

This document describes the new transaction simulation functionality added to the Intelligent DLMM Market Maker Bot.

## Overview

The transaction simulation feature allows you to test buy transactions without actually sending them to the blockchain. This helps:

- **Validate transactions** before execution
- **Estimate compute units** and fees
- **Detect potential errors** early
- **Optimize transaction structure**

## Configuration

Add these environment variables to enable simulation:

```bash
# Transaction Simulation Configuration
SIMULATION_ENABLED=false              # Enable/disable simulation
SIMULATION_COMMITMENT=confirmed       # RPC commitment level
SIMULATION_VALIDATE_ACCOUNTS=true     # Validate account existence
SIMULATION_LOG_DETAILS=true          # Show detailed logs
SIMULATION_FAIL_ON_ERROR=false       # Stop execution if simulation fails
```

## Features

### 1. Basic Transaction Simulation

Simulates transactions using Solana's `simulateTransaction` RPC:

```typescript
const simulator = new TransactionSimulator(connection, config);
const result = await simulator.simulateBuyTransaction(transaction, wallet);

console.log(`Success: ${result.success}`);
console.log(`Compute Units: ${result.unitsConsumed}`);
```

### 2. Account Validation

Checks if required accounts exist and validates wallet balances:

```typescript
const validation = await simulator.validateTransactionAccounts(transaction, wallet);
console.log(`Valid: ${validation.valid}`);
console.log(`Issues: ${validation.issues}`);
```

### 3. Fee Estimation

Estimates transaction fees using the latest Solana APIs:

```typescript
const estimatedFee = await simulator.estimateTransactionFees(transaction);
console.log(`Estimated Fee: ${estimatedFee / LAMPORTS_PER_SOL} SOL`);
```

### 4. Comprehensive Dry Run

Combines all validation steps into a single comprehensive test:

```typescript
const dryRun = await simulator.dryRunTransaction(transaction, wallet, {
  validateAccounts: true,
  logDetails: true,
});

console.log(`Simulation: ${dryRun.simulation.success ? "PASSED" : "FAILED"}`);
console.log(`Validation: ${dryRun.validation.valid ? "PASSED" : "FAILED"}`);
console.log(`Estimated Fee: ${dryRun.estimatedFee / LAMPORTS_PER_SOL} SOL`);
```

## Integration with Market Maker Bot

When simulation is enabled, the market maker bot will automatically simulate all transactions before sending them:

```typescript
// In market maker bot execution
if (this.config.simulation.enabled) {
  console.log("🧪 Simulating transactions before sending...");
  const simulationResults = await this.simulateTransactions(transactions, wallets);
  
  if (this.config.simulation.failOnSimulationError && simulationResults.some(r => !r.success)) {
    const failedCount = simulationResults.filter(r => !r.success).length;
    throw new Error(`${failedCount}/${transactions.length} transaction simulations failed`);
  }
}
```

## Configuration Options

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `SIMULATION_ENABLED` | `false` | Enable transaction simulation |
| `SIMULATION_COMMITMENT` | `confirmed` | RPC commitment level for simulation |
| `SIMULATION_VALIDATE_ACCOUNTS` | `true` | Validate account existence and balances |
| `SIMULATION_LOG_DETAILS` | `true` | Show detailed simulation logs |
| `SIMULATION_FAIL_ON_ERROR` | `false` | Stop execution if any simulation fails |

## Testing

Run the simulation test to verify functionality:

```bash
npm run test:simulation
```

This test will:
1. Create a test transaction
2. Run basic simulation
3. Perform account validation
4. Estimate fees
5. Execute comprehensive dry run

## Example Output

```
🧪 Starting transaction simulation...
🔍 Simulating transaction with 6 instructions
✅ Simulation successful
⚡ Compute units consumed: 89143
📋 Simulation logs:
  1: Program Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB invoke [1]
  2: Program log: Instruction: Swap
  3: Program Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB consumed 89143 of 1399700 compute units
  4: Program Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB success

📊 Dry Run Results:
==================
✅ Simulation: SUCCESS
⚡ Compute Units: 89143
🔍 Validation: PASSED
💰 Estimated Fee: 0.000005 SOL
==================
```

## Error Handling

Common simulation errors and their meanings:

- **AccountNotFound**: Required accounts don't exist (normal for new pools)
- **InsufficientFunds**: Wallet doesn't have enough balance
- **ComputeBudgetExceeded**: Transaction would consume too many compute units
- **InvalidInstruction**: Transaction instruction is malformed

## Performance Impact

- Simulation adds ~100-500ms per transaction
- Minimal RPC usage (1-2 calls per transaction)
- Can be disabled for production use if needed
- Account validation can be disabled for faster simulation

## Best Practices

1. **Enable for Testing**: Always enable simulation during development
2. **Production Use**: Consider enabling with `failOnSimulationError=false`
3. **Monitor Logs**: Review simulation logs for optimization opportunities
4. **Compute Unit Limits**: Use simulation results to set appropriate CU limits
5. **Account Pre-checks**: Use validation to catch common errors early
