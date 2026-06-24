import { OpenAI } from 'openai';
import { db } from '../db/index.js';
import { AgentInput, AgentDecision } from './types.js';
import { logger } from '../util/log.js';

const log = logger('agent');

export class Agent {
  private client: OpenAI;
  private model: string;

  constructor() {
    this.client = new OpenAI({
      baseURL: process.env.AI_RPC_URL || 'https://openrouter.ai/api/v1',
      apiKey: process.env.AI_API_KEY || '',
    });
    // Default to OpenRouter Llama 3.1 8B
    this.model = process.env.AI_MODEL || 'meta-llama/llama-3.1-8b-instruct';
  }

  public async evaluate(input: AgentInput): Promise<AgentDecision> {
    const systemPrompt = `You are an autonomous Solana transaction retry agent.
Your goal is to analyze transaction failures and determine the optimal retry strategy.
You must return a strict JSON object responding to the input context.
The context will include the failure reason, tip history, network congestion, and leader schedule.

Return ONLY a valid JSON object matching this schema:
{
  "diagnosis": "string (brief reasoning)",
  "confidence": "high" | "medium" | "low",
  "action": "RETRY" | "HOLD" | "ABORT",
  "params": {
    "submit_at_slot": number (optional, the exact slot to submit on),
    "new_tip_lamports": number (optional, the new tip to pay),
    "refresh_blockhash": boolean (optional)
  }
}

Rules:
- If 'fee too low' or 'auction dropped', bump the tip and RETRY.
- If 'blockhash expired', set refresh_blockhash to true and RETRY.
- If the target Jito leader is far away, you may HOLD or set submit_at_slot to the next Jito leader slot.
- If the remaining_tip_budget_lamports is exceeded, you MUST ABORT.`;

    const userPrompt = JSON.stringify(input, null, 2);

    try {
      const startTime = performance.now();
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.1, // Low temperature for consistent JSON
        response_format: { type: 'json_object' } // Enforce JSON
      });
      const latencyMs = Math.round(performance.now() - startTime);
      log.info(`Inference completed in ${latencyMs}ms using model ${this.model}`);

      const content = response.choices[0].message.content || '{}';
      const decision = JSON.parse(content) as AgentDecision;

      // Log decision to SQLite
      if (input.bundle?.bundle_id) {
        db.recordDecision(input.bundle.bundle_id, input.event, decision);
      }

      return this.enforceGuardrails(decision, input);
    } catch (err: any) {
      log.error(`Agent inference failed: ${err.message || err}`);
      // Fallback to safe abort
      return {
        diagnosis: "Agent inference failed",
        confidence: "low",
        action: "ABORT"
      };
    }
  }

  private enforceGuardrails(decision: AgentDecision, input: AgentInput): AgentDecision {
    // 1. Tip budget guardrail
    if (decision.params?.new_tip_lamports && input.network?.remaining_tip_budget_lamports) {
      if (decision.params.new_tip_lamports > input.network.remaining_tip_budget_lamports) {
        return {
          diagnosis: "Budget exceeded guardrail triggered",
          confidence: "high",
          action: "ABORT"
        };
      }
    }
    
    // 2. Ensure submit_at_slot is not in the past
    if (decision.params?.submit_at_slot && input.network?.current_slot) {
        if (decision.params.submit_at_slot < input.network.current_slot) {
            decision.params.submit_at_slot = input.network.current_slot + 1;
        }
    }

    return decision;
  }
}
