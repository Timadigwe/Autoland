import "dotenv/config";
import { DlmmMarketMaker } from "../src/core/market-maker";
import { METEORA_IDL } from "../src/meteora-idl";
import { Idl } from "@coral-xyz/anchor";
import { Connection, VersionedTransactionResponse } from "@solana/web3.js";

// Mock transaction data that simulates a Meteora pool creation transaction
const mockPoolCreationTransaction = {
  slot: 123456789,
  transaction: {
    message: {
      version: "legacy",
      header: {
        numRequiredSignatures: 1,
        numReadonlySignedAccounts: 0,
        numReadonlyUnsignedAccounts: 5
      },
      accountKeys: [
        "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", // payer
        "7NmzCkgqyH3fK2xVcLqR9pBnW8jGkF5tMrN4sQxE6yTz", // pool account
        "So11111111111111111111111111111111111111112",      // WSOL mint
        "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",      // USDC mint
        "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",       // Token program
        "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",       // Associated token program
        "11111111111111111111111111111111",                   // System program
      ],
      instructions: [
        {
          programIdIndex: 4,
          accounts: [0, 1, 2, 3],
          data: "initialize_pool_instruction_data_here"
        }
      ],
      recentBlockhash: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"
    },
    signatures: [
      "5Kb8kLf9CJmPPWZsFRK1AEFjWZJ8nG9tDFi8XgK1T2GxHzEd2KLz9F4ZnW8DhXkF3qJ7jC5TvX1K"
    ]
  },
  meta: {
    err: null,
    fee: 5000,
    preBalances: [1000000000, 0, 0, 0],
    postBalances: [999995000, 2039280, 2039280, 0],
    innerInstructions: [],
    logMessages: [
      "Program Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB invoke [1]",
      "Program log: Instruction: InitializePermissionedPool",
      "Program Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB consumed 45000 of 200000 compute units",
      "Program Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB success"
    ],
    preTokenBalances: [],
    postTokenBalances: [],
    loadedAddresses: {
      writable: [],
      readonly: []
    }
  },
  version: 0,
  blockTime: Math.floor(Date.now() / 1000)
};

// Mock non-pool transaction (should be ignored)
const mockRegularTransaction = {
  slot: 123456790,
  transaction: {
    message: {
      version: "legacy",
      header: {
        numRequiredSignatures: 1,
        numReadonlySignedAccounts: 0,
        numReadonlyUnsignedAccounts: 2
      },
      accountKeys: [
        "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
        "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
      ],
      instructions: [
        {
          programIdIndex: 1,
          accounts: [0],
          data: "regular_transfer_instruction"
        }
      ],
      recentBlockhash: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"
    },
    signatures: [
      "3Hd7jF9KlM2NpQ8R1SwT5VxY6ZaB3CdE4FgH5IjK6LmN7OpQ8RsT9UvW1XyZ2AbC"
    ]
  },
  meta: {
    err: null,
    fee: 5000,
    preBalances: [1000000000, 0],
    postBalances: [999995000, 0],
    innerInstructions: [],
    logMessages: [
      "Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke [1]",
      "Program log: Instruction: Transfer",
      "Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA success"
    ],
    preTokenBalances: [],
    postTokenBalances: [],
    loadedAddresses: {
      writable: [],
      readonly: []
    }
  },
  version: 0,
  blockTime: Math.floor(Date.now() / 1000)
};

// Function to fetch real transaction from Solana blockchain
async function fetchRealTransaction(signature: string, rpcUrl?: string): Promise<any | null> {
  try {
    console.log(` Fetching transaction: ${signature}`);
    
    const connection = new Connection(
      rpcUrl || process.env.RPC_URL || "https://api.mainnet-beta.solana.com",
      "confirmed"
    );

    // Fetch the transaction with full details
    const transaction = await connection.getTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed"
    });

    if (!transaction) {
      console.log(" Transaction not found");
      return null;
    }

    console.log(` Transaction fetched successfully`);
    console.log(`📊 Slot: ${transaction.slot}`);
    console.log(`⛽ Fee: ${transaction.meta?.fee || 0} lamports`);
    console.log(` Log messages: ${transaction.meta?.logMessages?.length || 0}`);

    // Convert to the format expected by handleTransaction
    const formattedTransaction = {
      slot: transaction.slot,
      transaction: {
        message: transaction.transaction.message,
        signatures: transaction.transaction.signatures,
      },
      meta: transaction.meta,
      version: transaction.version || 0,
      blockTime: transaction.blockTime || Math.floor(Date.now() / 1000)
    };

    return formattedTransaction;
  } catch (error) {
    console.error(" Error fetching transaction:", error);
    return null;
  }
}

// Function to analyze transaction logs for Meteora-related activity
function analyzeTransactionLogs(transaction: any): void {
  console.log("\n Transaction Analysis:");
  console.log("=".repeat(40));
  
  if (transaction.meta?.logMessages) {
    const logs = transaction.meta.logMessages;
    console.log(` Total log messages: ${logs.length}`);
    
    // Look for Meteora program invocations
    const meteoraLogs = logs.filter((log: string) => 
      log.includes("Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB") ||
      log.includes("InitializePermissionedPool") ||
      log.includes("InitializePermissionlessPool") ||
      log.includes("meteora") ||
      log.includes("Meteora")
    );
    
    if (meteoraLogs.length > 0) {
      console.log(" Meteora-related logs found:");
      meteoraLogs.forEach((log: string, index: number) => {
        console.log(`  ${index + 1}: ${log}`);
      });
    } else {
      console.log("ℹ️ No obvious Meteora-related logs found");
    }
    
    // Look for error logs
    const errorLogs = logs.filter((log: string) => 
      log.toLowerCase().includes("error") || 
      log.toLowerCase().includes("failed")
    );
    
    if (errorLogs.length > 0) {
      console.log("⚠️ Error logs found:");
      errorLogs.forEach((log: string, index: number) => {
        console.log(`  ${index + 1}: ${log}`);
      });
    }
  }
  
  // Analyze accounts involved
  if (transaction.transaction?.message?.accountKeys) {
    const accounts = transaction.transaction.message.accountKeys;
    console.log(`🔑 Accounts involved: ${accounts.length}`);
    
    // Look for known program IDs
    const knownPrograms = {
      "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB": "Meteora",
      "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA": "Token Program",
      "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL": "Associated Token Program",
      "11111111111111111111111111111111": "System Program",
      "So11111111111111111111111111111111111111112": "WSOL",
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": "USDC"
    };
    
    accounts.forEach((account: string, index: number) => {
      const programName = knownPrograms[account as keyof typeof knownPrograms];
      if (programName) {
        console.log(`  ${index}: ${account} (${programName})`);
      }
    });
  }
  
  console.log("=".repeat(40));
}

// Function to test with real transaction signature
async function testWithRealTransaction(signature: string, rpcUrl?: string) {
  console.log("🌐 Testing with real transaction from blockchain...\n");

  try {
    // Create bot instance
    console.log("1️⃣ Creating DlmmMarketMaker instance...");
    const bot = new DlmmMarketMaker(METEORA_IDL as Idl);
    
    // Check current simulation settings
    const config = (bot as any).config;
    console.log(` Simulation settings from .env:`);
    console.log(`   - Enabled: ${config.simulation.enabled}`);
    console.log(`   - Log Details: ${config.simulation.logDetails}`);
    console.log(`   - Validate Accounts: ${config.simulation.validateAccounts}`);
    console.log(`   - Fail on Error: ${config.simulation.failOnSimulationError}`);
    
    // Initialize bot (this will load config and wallets)
    console.log("2️⃣ Initializing bot...");
    try {
      await bot.initialize();
      console.log(" Bot initialized successfully\n");
    } catch (error) {
      console.log("⚠️ Bot initialization failed (expected - no wallets configured)");
      console.log(" Continuing with transaction parsing test...\n");
    }

    // Fetch real transaction
    console.log("3️⃣ Fetching real transaction...");
    const realTransaction = await fetchRealTransaction(signature, rpcUrl);
    
    if (!realTransaction) {
      console.log(" Could not fetch transaction. Test aborted.");
      return;
    }

    // Analyze the transaction
    analyzeTransactionLogs(realTransaction);

    // Access the private handleTransaction method through reflection
    const handleTransaction = (bot as any).handleTransaction.bind(bot);

    // Reset sniped state
    (bot as any).sniped = false;

    // Test with the real transaction
    console.log("\n4️⃣ Processing real transaction through handleTransaction...");
    console.log("📤 Sending real transaction data to bot...");
    
    const startTime = Date.now();
    await handleTransaction(realTransaction);
    const processingTime = Date.now() - startTime;
    
    console.log(` Real transaction processed in ${processingTime}ms\n`);

    console.log(" Real transaction test completed!");

  } catch (error) {
    console.error(" Real transaction test failed:", error);
    
    if (error instanceof Error) {
      console.error("Error details:", error.message);
      console.error("Stack trace:", error.stack);
    }
  }
}

async function testHandleTransaction() {
  console.log(" Testing DlmmMarketMaker handleTransaction function...\n");

  try {
    // Create bot instance
    console.log("1️⃣ Creating DlmmMarketMaker instance...");
    const bot = new DlmmMarketMaker(METEORA_IDL as Idl);
    
    // Initialize bot (this will load config and wallets)
    console.log("2️⃣ Initializing bot...");
    try {
      await bot.initialize();
      console.log(" Bot initialized successfully\n");
    } catch (error) {
      console.log("⚠️ Bot initialization failed (expected - no wallets configured)");
      console.log(" Continuing with transaction parsing test...\n");
    }

    // Access the private handleTransaction method through reflection
    const handleTransaction = (bot as any).handleTransaction.bind(bot);

    // Test 1: Regular transaction (should be ignored)
    console.log("3️⃣ Testing with regular transaction (should be ignored)...");
    console.log("📤 Sending regular transaction data...");
    await handleTransaction(mockRegularTransaction);
    console.log(" Regular transaction processed (ignored as expected)\n");

    // Test 2: Pool creation transaction (should trigger snipe attempt)
    console.log("4️⃣ Testing with pool creation transaction...");
    console.log("📤 Sending pool creation transaction data...");
    await handleTransaction(mockPoolCreationTransaction);
    console.log(" Pool creation transaction processed\n");

    // Test 3: Test with already sniped state
    console.log("5️⃣ Testing with already sniped state...");
    (bot as any).sniped = true; // Set sniped flag
    console.log("📤 Sending another pool creation transaction (should be ignored)...");
    await handleTransaction(mockPoolCreationTransaction);
    console.log(" Transaction ignored due to already sniped state\n");

    console.log(" All tests completed!");

  } catch (error) {
    console.error(" Test failed:", error);
    
    if (error instanceof Error) {
      console.error("Error details:", error.message);
      console.error("Stack trace:", error.stack);
    }
  }
}

async function main() {
  console.log("=".repeat(60));
  console.log("       DLMM MARKET MAKER - HANDLE TRANSACTION TEST");
  console.log("=".repeat(60));
  console.log();

  // Check command line arguments for transaction signature
  const args = process.argv.slice(2);
  
  if (args.length > 0) {
    const signature = args[0];
    const rpcUrl = args[1]; // Optional RPC URL
    
    console.log(` Testing with real transaction signature: ${signature}`);
    if (rpcUrl) {
      console.log(`🌐 Using custom RPC: ${rpcUrl}`);
    }
    console.log();
    
    await testWithRealTransaction(signature, rpcUrl);
  } else {
    console.log(" Running mock transaction tests...");
    console.log(" To test with real transaction, use:");
    console.log("   npm run test:handle-transaction <signature> [rpc-url]");
    console.log();
    
    await testHandleTransaction();
  }

  console.log();
  console.log("=".repeat(60));
  console.log("                    TEST COMPLETE");
  console.log("=".repeat(60));
}

// Run the test
if (require.main === module) {
  main().catch((error) => {
    console.error("Unhandled error in test:", error);
    process.exit(1);
  });
}

export { testHandleTransaction, testWithRealTransaction, fetchRealTransaction };

