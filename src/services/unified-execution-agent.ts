import OpenAI from 'openai';
import { ConfigManager } from '../utils/config';
import { Logger } from '../utils/logger';
export interface FailureTelemetry {
  errorType: "BlockhashExpired" | "SlippageExceeded" | "SimulationError" | "Dropped" | "Unknown";
  errorMessage: string;
  slotFired: number;
  currentSlot: number;
}

export interface ExecutionDecision {
  action: "RETRY" | "HALT";
  reasoning: string;
  mutations?: {
    refreshBlockhash?: boolean;
    overrideTipLamports?: number; // The dynamic tip to use for the retry
  };
}

export class UnifiedExecutionAgent {
  private openai: OpenAI | null = null;
  private logger: Logger;
  
  // Base Line Memory
  private competitorTips: number[] = [];
  private cachedBaselineTip: number = 50000; // Default 0.00005 SOL
  private updateInterval: NodeJS.Timeout | null = null;
  
  // Hardcoded safety ceiling: 0.005 SOL (5,000,000 lamports) to prevent AI drain
  private readonly MAX_TIP_CEILING = 5000000; 

  constructor() {
    this.logger = Logger.getInstance();
    const config = ConfigManager.getInstance().getConfig();
    
    if (config.ai.openRouterApiKey) {
      this.openai = new OpenAI({
        baseURL: "https://openrouter.ai/api/v1",
        apiKey: config.ai.openRouterApiKey,
      });
    }
  }

  // --- 1. Background Competitor Tip Baseline ---

  public recordCompetitorTip(tipLamports: number) {
    if (tipLamports > 0 && tipLamports < 100 * 1e9) {
      this.competitorTips.push(tipLamports);
      // Keep last 50 competitor tips
      if (this.competitorTips.length > 50) this.competitorTips.shift();
      
      // Calculate max or 90th percentile to be aggressive
      const sorted = [...this.competitorTips].sort((a, b) => a - b);
      const p90 = sorted[Math.floor(sorted.length * 0.9)] || 50000;
      this.cachedBaselineTip = p90;
    }
  }

  public getBaselineTipLamports(): number {
    return Math.min(this.cachedBaselineTip, this.MAX_TIP_CEILING);
  }

  // --- 2. Reactive AI Retry Logic ---

  public async analyzeFailureSequence(
    telemetry: FailureTelemetry,
    previousTipLamports: number,
    attemptNumber: number
  ): Promise<ExecutionDecision> {
    if (!this.openai) {
       this.logger.warn(" [UNIFIED AGENT] AI API Key missing. Defaulting to safe fallback.");
       return {
         action: "RETRY",
         reasoning: "API missing fallback",
         mutations: { refreshBlockhash: true, overrideTipLamports: Math.min(previousTipLamports * 2, this.MAX_TIP_CEILING) }
       };
    }

    try {
      this.logger.info(` [UNIFIED AGENT] Analyzing Failure at Attempt ${attemptNumber}...`);
      
      const config = ConfigManager.getInstance().getConfig();
      
      const prompt = `You are a Tier-1 Solana MEV Execution Agent.
Your transaction just FAILED. 
Attempt Number: ${attemptNumber}
Tip Paid: ${previousTipLamports} lamports
Error Type: ${telemetry.errorType}
Error Details: ${telemetry.errorMessage}
Competitor Baseline Tip: ${this.cachedBaselineTip} lamports

Analyze why it failed. 
If it failed due to BlockhashExpired, it means your tip was outbid in the Jito auction. You must aggressively raise the tip.
If it failed due to SlippageExceeded, the pool moved too much.
If it failed due to SimulationError and the details show Jito dropped it, it means the price shifted and Jito protected you from paying a tip for a reverted trade. You MUST RETRY with a refreshed blockhash and a newly calculated strategy, maintaining or increasing the tip.

Decide whether to HALT the trade, or RETRY with a refreshed blockhash and a NEW dynamically calculated overrideTipLamports.
Max Tip ceiling is 5000000 lamports. Never exceed this.

Output strictly valid JSON matching this interface:
{
  "action": "RETRY" | "HALT",
  "reasoning": "short explanation",
  "mutations": {
    "refreshBlockhash": true,
    "overrideTipLamports": 120000
  }
}`;

      const completion = await this.openai.chat.completions.create({
        model: config.ai.model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.1, // Low temperature for deterministic, logical escalation
      });

      const responseContent = completion.choices[0]?.message?.content || "";
      const parsed = JSON.parse(responseContent.replace(/```json/g, '').replace(/```/g, '').trim());
      
      // Enforce the hardcoded safety ceiling
      if (parsed.mutations && parsed.mutations.overrideTipLamports) {
         parsed.mutations.overrideTipLamports = Math.min(parsed.mutations.overrideTipLamports, this.MAX_TIP_CEILING);
      }

      this.logger.info(` [AI REASONING] Agent dictates ${parsed.action}. Reason: ${parsed.reasoning}.`);
      if (parsed.mutations?.overrideTipLamports) {
          this.logger.info(` [AI REASONING] Agent mutated retry tip to ${parsed.mutations.overrideTipLamports} lamports.`);
      }
      
      return parsed as ExecutionDecision;

    } catch (e: any) {
      this.logger.warn(` [UNIFIED AGENT] Failed to execute AI reasoning: ${e.message}`);
      return {
        action: "RETRY",
        reasoning: "Error fallback. Aggressive 2x scalar.",
        mutations: { refreshBlockhash: true, overrideTipLamports: Math.min(previousTipLamports * 2, this.MAX_TIP_CEILING) }
      };
    }
  }
}
