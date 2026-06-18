import "dotenv/config";
import { AiTippingAgent } from "../src/services/ai-tipping-agent";

async function testAgent() {
  console.log("Testing AI Tipping Agent...");
  const agent = new AiTippingAgent();

  const mockData = {
    recentSlot: 150000000,
    recentBlockhash: "mockhash123",
    transactionsInRecentBlocks: 4500, // Very high
    estimatedAveragePriorityFee: 50000,
    poolVolatility: "High" as const,
    jitoTipPercentile50: 50000,
    distanceToJitoLeader: 0,
    timeSinceLastTradeMs: 10,
    recentPerformance: {
      slot: 150000000,
      computeUnitsConsumed: 50000,
      timeInMs: 10,
      tipMicroLamports: 50000
    }
  };

  console.log("Input data (High congestion):", mockData);
  const tip1 = await agent.determineOptimalTip(mockData);
  console.log(`Tip generated: ${tip1} lamports (${tip1 / 1e9} SOL)\n`);

  const mockData2 = {
    recentSlot: 150000000,
    recentBlockhash: "mockhash123",
    transactionsInRecentBlocks: 500, // Very low
    estimatedAveragePriorityFee: 1000,
    poolVolatility: "Low" as const,
    jitoTipPercentile50: 1000,
    distanceToJitoLeader: 2,
    timeSinceLastTradeMs: 10000,
    recentPerformance: {
      slot: 150000000,
      computeUnitsConsumed: 1000,
      timeInMs: 10000,
      tipMicroLamports: 1000
    }
  };

  console.log("Input data (Low congestion):", mockData2);
  const tip2 = await agent.determineOptimalTip(mockData2);
  console.log(`Tip generated: ${tip2} lamports (${tip2 / 1e9} SOL)`);
}

testAgent().catch(console.error);
