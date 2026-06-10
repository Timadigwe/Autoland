import OpenAI from 'openai';
import { ConfigManager } from '../utils/config';
import { Logger } from '../utils/logger';

export interface NetworkCongestionData {
  recentSlot: number;
  recentBlockhash: string;
  transactionsInRecentBlocks: number;
  estimatedAveragePriorityFee: number; // micro lamports
  jitoTipPercentile50: number; // median tip lamports from tip stream
  poolVolatility: "Low" | "Medium" | "High";
  timeSinceLastTradeMs: number;
}

export class AiTippingAgent {
  private openai: OpenAI;
  private model: string;
  private logger: Logger;
  private defaultTip: number;

  constructor() {
    const config = ConfigManager.getInstance().getConfig();
    this.openai = new OpenAI({
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: config.ai.openRouterApiKey,
    });
    this.model = config.ai.model;
    this.logger = Logger.getInstance();
    this.defaultTip = config.trading.priorityFeeMicroLamports;
  }

  /**
   * Generates a Jito tip amount based on network congestion using the OpenRouter AI model.
   * @param data Live data from GRPC stream about the network and pool
   * @returns Tip amount in lamports
   */
  public async determineOptimalTip(data: NetworkCongestionData): Promise<number> {
    const prompt = this.buildPrompt(data);
    
    try {
      this.logger.info(`Requesting tip prediction from ${this.model}...`);
      
      const completion = await this.openai.chat.completions.create({
        model: this.model,
        messages: [
          {
            role: "system",
            content: `You are an AI specialized in Solana MEV and Jito block building. 
Your task is to analyze network congestion and pool volatility to output an optimal Jito tip amount (in lamports). 
You must return ONLY a JSON object with exactly one key "optimalTipLamports" and a numeric value. Do not include any markdown formatting, just the raw JSON string.`
          },
          {
            role: "user",
            content: prompt
          }
        ],
        temperature: 0.2, // Low temperature for consistent numerical outputs
      });

      const responseContent = completion.choices[0]?.message?.content;
      
      if (!responseContent) {
        this.logger.error("Empty response from AI model, falling back to default tip.");
        return this.defaultTip;
      }

      // Try to parse the JSON response
      try {
        const cleanContent = responseContent.replace(/```json/g, '').replace(/```/g, '').trim();
        const parsed = JSON.parse(cleanContent);
        
        if (parsed.optimalTipLamports && typeof parsed.optimalTipLamports === 'number') {
          this.logger.success(`Calculated tip: ${parsed.optimalTipLamports} lamports`);
          return parsed.optimalTipLamports;
        } else {
          throw new Error("Invalid JSON structure returned by AI");
        }
      } catch (parseError) {
        this.logger.error(`Failed to parse AI response: ${responseContent}. Error: ${parseError}`);
        return this.defaultTip;
      }
      
    } catch (error) {
      this.logger.error(`Error communicating with OpenRouter: ${error}`);
      return this.defaultTip; // Fallback to default configured tip
    }
  }

  private buildPrompt(data: NetworkCongestionData): string {
    return JSON.stringify({
      context: "Solana DLMM Market Making Execution",
      liveMetrics: {
        currentSlot: data.recentSlot,
        txsInRecentBlocks: data.transactionsInRecentBlocks,
        avgPriorityFeeMicroLamports: data.estimatedAveragePriorityFee,
        liveMedianJitoTipLamports: data.jitoTipPercentile50,
        poolVolatility: data.poolVolatility,
        msSinceLastTrade: data.timeSinceLastTradeMs
      },
      task: "Calculate the required Jito bundle tip in lamports to ensure >95% probability of inclusion in the next block without severely overpaying.",
      constraints: {
        minimumTipLamports: 1000,
        maximumTipLamports: 1000000 // 0.001 SOL max
      }
    });
  }
}
