import { Connection, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { TransactionSimulator } from "../src/services/transaction-simulator";
import { MeteoraTransactionBuilder } from "../src/services/transaction-builder";
import { ConfigManager } from "../src/utils/config";
import { PoolAccounts } from "../src/types/config";
import * as dotenv from "dotenv";

dotenv.config();

async function testSimulation() {
  console.log("============================================================");
  console.log("       DLMM MARKET MAKER - TRANSACTION SIMULATION TEST");
  console.log("============================================================");

  try {
    // Create test configuration with simulation enabled
    const config = ConfigManager.getInstance().getConfig();
    config.simulation.enabled = true;
    config.simulation.logDetails = true;
    config.simulation.validateAccounts = true;

    // Initialize connection
    const connection = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
    
    // Create simulator and transaction builder
    const simulator = new TransactionSimulator(connection, config);
    const transactionBuilder = new MeteoraTransactionBuilder(
      config.meteora.programId,
      config
    );

    // Create a test wallet
    const testWallet = Keypair.generate();
    console.log(`🔑 Test wallet: ${testWallet.publicKey.toString()}`);

    // Mock pool accounts (using real addresses from previous test)
    const mockPoolAccounts: PoolAccounts = {
      pool: "D1By4TsVRPKx12d37gJ3Y7CwfnwMVh4bb61z68Po4x8a",
      lpMint: "7ryhhuUwj8XdKvcBSgGN3eZqc2xAW1oBuChLTcpQR6PY",
      tokenMintA: "So11111111111111111111111111111111111111112", // SOL
      tokenMintB: "4Ypj7kbXbYiX7HY2RHJ6NFrokiqHPpeGioMcjJ2rmoon",
      aVault: "FERjPVNEa7Udq8CEv68h6tPL46Tq7ieE49HrE2wea3XT",
      bVault: "5uu52MAojd1gP4q4Xk8STKZaCz489MUhyLzs2EPGJSWH",
      aTokenVault: "HZeLxbZ9uHtSpwZC3LBr4Nubd14iHwz7bRSghRZf5VCG",
      bTokenVault: "6axaa7E14r88XRbRztbRmCZwkTJpvBhbnnZeJi9vT5g7",
      aVaultLpMint: "FZN7QZ8ZUUAxMPfxYEYkH3cXUASzH8EqA6B4tyCL8f1j",
      bVaultLpMint: "8zhZrWR4m6WXMnPo7Hr7zg9jTpptn3Dxc6RutyeVB1go",
      aVaultLp: "BtU9CENDH939wk1n5q7FMskEQdFhmXSnLbUnSLZv7wSt",
      bVaultLp: "3z1onS9HnyN6kbUY1jTqncHhgdvyQd9mPJNuLHfysq3F",
      protocolTokenFee: "5vTiUqpobSZ18aRfCXXBZEHxc47HA1Gbw1dLSK2CpGzv",
    };

    console.log(" Building test buy transaction...");
    
    // Build a test transaction
    const testTransaction = await transactionBuilder.buildBuyTransaction(
      testWallet,
      mockPoolAccounts,
      0.001 // Small amount for testing
    );

    console.log(` Transaction built with ${testTransaction.instructions.length} instructions`);
    console.log(" Starting simulation test...");

    // Test basic simulation
    const simulationResult = await simulator.simulateBuyTransaction(
      testTransaction,
      testWallet
    );

    console.log("📊 Simulation Results:");
    console.log("======================");
    console.log(` Success: ${simulationResult.success}`);
    
    if (simulationResult.error) {
      console.log(` Error: ${simulationResult.error}`);
    }
    
    if (simulationResult.unitsConsumed) {
      console.log(` Compute Units: ${simulationResult.unitsConsumed}`);
    }
    
    if (simulationResult.logs && simulationResult.logs.length > 0) {
      console.log("📋 Transaction Logs:");
      simulationResult.logs.slice(0, 5).forEach((log, index) => {
        console.log(`  ${index + 1}: ${log}`);
      });
      if (simulationResult.logs.length > 5) {
        console.log(`  ... and ${simulationResult.logs.length - 5} more logs`);
      }
    }

    // Test dry run functionality
    console.log("\n Testing dry run functionality...");
    
    const dryRunResult = await simulator.dryRunTransaction(
      testTransaction,
      testWallet,
      {
        validateAccounts: true,
        logDetails: true,
      }
    );

    console.log("📊 Dry Run Complete!");
    console.log("=====================");
    
    if (dryRunResult.validation) {
      console.log(` Account Validation: ${dryRunResult.validation.valid ? "PASSED" : "FAILED"}`);
      if (dryRunResult.validation.issues.length > 0) {
        console.log("⚠️ Validation Issues:");
        dryRunResult.validation.issues.forEach(issue => {
          console.log(`  - ${issue}`);
        });
      }
    }

    if (dryRunResult.estimatedFee) {
      console.log(` Estimated Fee: ${dryRunResult.estimatedFee / LAMPORTS_PER_SOL} SOL`);
    }

    console.log("\n Simulation test completed successfully!");

  } catch (error) {
    console.error(" Simulation test failed:", error);
    process.exit(1);
  }
}

// Run the test
if (require.main === module) {
  testSimulation().catch(console.error);
}
