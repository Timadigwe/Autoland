import "dotenv/config";
import { DlmmMarketMaker } from "./core/market-maker";
import { Idl } from "@coral-xyz/anchor";
import { METEORA_IDL } from "./meteora-idl";

import { Logger } from "./utils/logger";

Logger.getInstance().hijackConsole();

async function main() {
  console.log("Intelligent DLMM Market Maker Bot Starting...");
  console.log("=======================================");

  try {
    const bot = new DlmmMarketMaker(METEORA_IDL as Idl);

    await bot.initialize();

    console.log("\nPre-trade wallet balances:");
    await bot.getWalletBalances();

    process.on("SIGINT", () => {
      console.log("\nReceived interrupt signal, shutting down gracefully...");
      bot.stop();
      process.exit(0);
    });

    process.on("SIGTERM", () => {
      console.log("\nReceived terminate signal, shutting down gracefully...");
      bot.stop();
      process.exit(0);
    });

    await bot.start();

    // Setup Keyboard Listener for dynamic testing
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding('utf8');
      console.log(" \n[READY] Press 'f' to trigger a dynamic failure test. Press 'Ctrl+C' to exit.\n");
      
      process.stdin.on('data', (key: string) => {
        if (key === '\u0003') { // Ctrl+C
          console.log('\nReceived interrupt signal, shutting down gracefully...');
          bot.stop();
          process.exit(0);
        }
        if (key.toLowerCase() === 'f') {
          bot.testJitoFailure().catch(console.error);
        }
      });
    }

  } catch (error) {
    console.error("Fatal error:", error);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error("Unhandled error:", error);
    process.exit(1);
  });
}

export { DlmmMarketMaker };