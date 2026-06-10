import "dotenv/config";
import { DlmmMarketMaker } from "./core/market-maker";
import { Idl } from "@coral-xyz/anchor";
import { METEORA_IDL } from "./meteora-idl";

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