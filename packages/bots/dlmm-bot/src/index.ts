import "dotenv/config";
import { DlmmBot } from "./core/bot";
import { Logger } from "./utils/logger";

Logger.getInstance().hijackConsole();

async function main(): Promise<void> {
  console.log("Intelligent DLMM Market Maker Bot");
  console.log("=================================");

  const bot = new DlmmBot();

  await bot.initialize();

  console.log("\nWallet balances:");


  const shutdown = () => {
    console.log("\nShutting down...");
    bot.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    console.log("\n[READY] Press 'f' to inject a Jito failure test. Press Ctrl+C to exit.\n");

    process.stdin.on("data", (key: string) => {
      if (key === "\u0003") {
        shutdown();
      }
      if (key.toLowerCase() === "f") {
        // bot.testJitoFailure().catch(console.error);
      }
    });
  }

  await bot.start();
}

if (require.main === module) {
  main().catch((error) => {
    console.log("--- CRASH DETECTED ---");
    console.log(error);
    if (error && error.message) console.log("Message:", error.message);
    if (error && error.stack) console.log("Stack:", error.stack);
    console.log("----------------------");
    process.exit(1);
  });
}

export { DlmmBot };
