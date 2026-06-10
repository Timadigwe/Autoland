import OpenAI from 'openai';
import { ConfigManager } from '../utils/config';
import { Logger } from '../utils/logger';
import { StrategyType } from '@meteora-ag/dlmm';

export interface PoolConditions {
  volatility: "Low" | "Medium" | "High";
  trend: "Neutral" | "Bullish" | "Bearish";
  recentSwapCount: number;
  averageSwapSizeSol: number;
}

export interface AiStrategyResponse {
  strategyType: StrategyType;
  minBinOffset: number; // e.g., -20
  maxBinOffset: number; // e.g., 20
}

export class AiStrategyAgent {
  private openai: OpenAI;
  private model: string;
  private logger: Logger;

  constructor() {
    const config = ConfigManager.getInstance().getConfig();
    this.openai = new OpenAI({
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: config.ai.openRouterApiKey,
    });
    this.model = config.ai.model;
    this.logger = Logger.getInstance();
  }

  public async determineOptimalStrategy(data: PoolConditions): Promise<AiStrategyResponse> {
    const prompt = this.buildPrompt(data);
    
    // Default safe fallback strategy
    const defaultStrategy: AiStrategyResponse = {
      strategyType: StrategyType.Spot,
      minBinOffset: -10,
      maxBinOffset: 10
    };

    try {
      this.logger.info(`Requesting LP strategy prediction from ${this.model}...`);
      
      const completion = await this.openai.chat.completions.create({
        model: this.model,
        messages: [
          {
            role: "system",
            content: `You are an AI specialized in Solana MEV and Meteora DLMM market making.
Your task is to analyze pool volatility and directional trend to output an optimal LP strategy.
You must return ONLY a JSON object with exactly three keys:
- "strategyType" (must be the string "Spot", "Curve", or "BidAsk")
- "minBinOffset" (a negative integer representing bins below current price)
- "maxBinOffset" (a positive integer representing bins above current price)
Do not include any markdown formatting, just the raw JSON string.`
          },
          {
            role: "user",
            content: prompt
          }
        ],
        temperature: 0.1, // Very low temp for strict JSON adherence
      });

      const responseContent = completion.choices[0]?.message?.content;
      
      if (!responseContent) {
        this.logger.error("Empty response from AI strategy model, falling back to default.");
        return defaultStrategy;
      }

      try {
        const cleanContent = responseContent.replace(/```json/g, '').replace(/```/g, '').trim();
        const parsed = JSON.parse(cleanContent);
        
        let parsedStrategyType = StrategyType.Spot;
        if (parsed.strategyType === "Curve") parsedStrategyType = StrategyType.Curve;
        if (parsed.strategyType === "BidAsk") parsedStrategyType = StrategyType.BidAsk;

        this.logger.success(`Calculated strategy: ${parsed.strategyType} [${parsed.minBinOffset}, ${parsed.maxBinOffset}]`);
        
        return {
          strategyType: parsedStrategyType,
          minBinOffset: parsed.minBinOffset || -10,
          maxBinOffset: parsed.maxBinOffset || 10
        };

      } catch (parseError) {
        this.logger.error(`Failed to parse AI strategy response: ${responseContent}. Error: ${parseError}`);
        return defaultStrategy;
      }
      
    } catch (error) {
      this.logger.error(`Error communicating with OpenRouter for Strategy: ${error}`);
      return defaultStrategy; 
    }
  }

  private buildPrompt(data: PoolConditions): string {
    return JSON.stringify({
      context: "Meteora DLMM LP Strategy Optimization",
      poolConditions: data,
      rules: {
        Spot: "Used for stable/ranging markets. Distributes liquidity evenly.",
        Curve: "Used for very low volatility. Concentrates liquidity tightly around active bin.",
        BidAsk: "Used for high volatility. Widens spread to capture fees safely.",
        trendOffset: "If bullish, you may skew positive (e.g. [-5, +20]). If bearish, skew negative."
      }
    });
  }
}
