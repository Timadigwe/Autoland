import { OpenAI } from 'openai';
import { db } from './db.js';
import { logger } from '../common/logger.js';
import { tipFloorService } from '../dispatch/fees.js';

const log = logger('agent');

export interface AgentInput {
  event: string;
  failure: any;
  bundle?: {
    bundle_id?: string;
    attempt: number;
    tip_lamports: number;
    tip_account: string;
    submitted_slot: number;
    target_leader_slot: number;
  };
  network?: {
    current_slot: number;
    slot_skip_rate_64: number;
    processed_to_confirmed_ms_p50: number;
    tip_floor: any;
    next_jito_leader_slot: number;
    slots_until_jito_leader: number;
    remaining_tip_budget_lamports?: number;
  };
  history?: Array<{ attempt: number; outcome: string }>;
}

export interface AgentDecision {
  diagnosis: string;
  confidence: 'high' | 'medium' | 'low';
  action: 'RETRY' | 'HOLD' | 'ABORT' | 'FALLBACK_RPC';
  params?: {
    submit_at_slot?: number;
    new_tip_lamports?: number;
    refresh_blockhash?: boolean;
  };
}

const tools = [
  {
    type: "function" as const,
    function: {
      name: "get_recent_lifecycles",
      description: "Get the most recent transaction/bundle lifecycle entries from the database to analyze recent landing status and failure types.",
      parameters: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: "Number of recent lifecycles to retrieve (default is 10)"
          }
        }
      }
    }
  },
  {
    type: "function" as const,
    function: {
      name: "get_recent_decisions",
      description: "Get the most recent AI retry agent decisions from the database to see what actions were chosen for prior transactions.",
      parameters: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: "Number of recent decisions to retrieve (default is 10)"
          }
        }
      }
    }
  },
  {
    type: "function" as const,
    function: {
      name: "get_tip_percentile_info",
      description: "Compare a given tip in lamports against the current Jito tip floor percentiles to see where it stands.",
      parameters: {
        type: "object",
        properties: {
          tipLamports: {
            type: "number",
            description: "The tip value in lamports to analyze"
          }
        },
        required: ["tipLamports"]
      }
    }
  }
];

function parseJSONDecision(text: string): AgentDecision {
  let cleaned = text.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(json)?/, "").replace(/```$/, "").trim();
  }
  return JSON.parse(cleaned) as AgentDecision;
}

export class Agent {
  private client: OpenAI;
  private model: string;

  constructor() {
    this.client = new OpenAI({
      baseURL: process.env.AI_RPC_URL || 'https://openrouter.ai/api/v1',
      apiKey: process.env.AI_API_KEY || '',
    });
    this.model = process.env.AI_MODEL || 'meta-llama/llama-3.1-8b-instruct';
  }

  public async evaluate(input: AgentInput): Promise<AgentDecision> {
    const systemPrompt = `You are an autonomous Solana transaction retry agent.
Your goal is to analyze transaction failures and determine the optimal retry strategy.
You must return a strict JSON object responding to the input context.
The context will include the failure reason, tip history, network congestion, and leader schedule.

You have access to autonomous tools to query real-time database state and analyze tip floor levels:
- Use 'get_recent_lifecycles' to query the SQLite database for recent bundle failures, signatures, tip amounts, and failure types.
- Use 'get_recent_decisions' to retrieve recent actions and diagnoses decided by the retry agent.
- Use 'get_tip_percentile_info' to compare any tip (e.g. the one that just failed or a new proposed tip) against the current live Jito tip floors (p25, p50, p75, p95, p99) to determine its percentile category.
Before making your final retry or fallback decision, you should invoke these tools autonomously to inspect past history and perform analysis.

Return ONLY a valid JSON object matching this schema:
{
  "diagnosis": "string (brief reasoning)",
  "confidence": "high" | "medium" | "low",
  "action": "RETRY" | "HOLD" | "ABORT" | "FALLBACK_RPC",
  "params": {
    "submit_at_slot": number (optional, the exact slot to submit on),
    "new_tip_lamports": number (optional, the new tip to pay),
    "refresh_blockhash": boolean (optional)
  }
}

Rules:
- If 'fee too low' or 'auction dropped', bump the tip and RETRY. You must calculate and set a bumped tip in 'new_tip_lamports' inside 'params' (at least 1.5x of the previous attempt's tip_lamports).
- If the failure is 'bundle_dropped', the Jito block engine or validator dropped the bundle without execution. You should bump the tip and RETRY by specifying a higher 'new_tip_lamports' (at least 1.5x the previous attempt's tip_lamports) in 'params', or choose to HOLD if congestion is extremely high.
- If 'blockhash expired', set refresh_blockhash to true and RETRY.
- If the failure is 'leader_skip', the Jito validator scheduled slot was skipped; you should HOLD or set submit_at_slot to the next Jito leader slot.
- If the remaining_tip_budget_lamports is exceeded, you MUST ABORT.
- If you detect Jito Block Engine rate-limiting (e.g. 'HTTP 429 Too Many Requests', API errors), or Jito Block Engine is failing/unreachable, you should choose to bypass Jito and submit via normal public RPC. In this case, select the action "FALLBACK_RPC".
- You must carefully analyze the 'history' array of prior failures. If two or more attempts have failed with the same outcome (e.g. successive 'bundle_dropped' or Jito invalidations), do NOT keep retrying Jito with similar tips. You must either:
  1. Escalate the tip significantly (set 'new_tip_lamports' to 2.0x or more of the previous attempt's tip).
  2. Switch your action to 'HOLD' to pause execution and wait for slot leader window alignment/congestion to clear.
  3. Switch your action to 'FALLBACK_RPC' to bypass Jito completely and land the transaction via public RPC.
- Specifically, if the transaction has failed Jito submission 3 times (input.bundle.attempt >= 3), you MUST select the action "FALLBACK_RPC" on the next attempt to guarantee transaction inclusion.`;

    const userPrompt = JSON.stringify(input, null, 2);

    try {
      const startTime = performance.now();
      const messages: any[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ];

      let run = true;
      let decision: AgentDecision | null = null;
      let iterations = 0;
      const MAX_ITERATIONS = 5;

      while (run && iterations < MAX_ITERATIONS) {
        iterations++;
        const response = await this.client.chat.completions.create({
          model: this.model,
          messages,
          temperature: 0.1,
          tools,
          tool_choice: "auto"
        });

        const msg = response.choices[0].message;
        messages.push(msg);

        if (msg.tool_calls && msg.tool_calls.length > 0) {
          for (const toolCall of msg.tool_calls) {
            const name = toolCall.function.name;
            const args = JSON.parse(toolCall.function.arguments || '{}');
            log.info(`Agent requested tool execution: ${name}`, { args });

            let resultStr = "";
            try {
              if (name === "get_recent_lifecycles") {
                const history = await db.getRecentLifecycles(args.limit || 10);
                resultStr = JSON.stringify(history);
              } else if (name === "get_recent_decisions") {
                const decisions = await db.getRecentDecisions(args.limit || 10);
                resultStr = JSON.stringify(decisions);
              } else if (name === "get_tip_percentile_info") {
                const tf = await tipFloorService().get();
                const tip = args.tipLamports;
                let range = "< p25";
                if (tip >= tf.p99) range = ">= p99";
                else if (tip >= tf.p95) range = "p95-p99";
                else if (tip >= tf.p75) range = "p75-p95";
                else if (tip >= tf.p50) range = "p50-75";
                else if (tip >= tf.p25) range = "p25-p50";
                
                resultStr = JSON.stringify({
                  tipFloor: tf,
                  analyzedTipLamports: tip,
                  percentileRange: range
                });
              } else {
                resultStr = `Unknown tool: ${name}`;
              }
            } catch (err: any) {
              resultStr = `Error executing tool: ${err.message || err}`;
            }

            messages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              content: resultStr
            });
          }
        } else {
          const content = msg.content || '{}';
          decision = parseJSONDecision(content);
          run = false;
        }
      }

      if (!decision) {
        throw new Error("No decision generated after max tool iterations");
      }

      const latencyMs = Math.round(performance.now() - startTime);
      log.info(`Inference and autonomous tool execution completed in ${latencyMs}ms using model ${this.model}`);

      if (input.bundle?.bundle_id) {
        db.recordDecision(input.bundle.bundle_id, input.event, decision);
      }

      return this.enforceGuardrails(decision, input);
    } catch (err: any) {
      log.error(`Agent inference failed: ${err.message || err}`);
      return {
        diagnosis: "Agent inference failed",
        confidence: "low",
        action: "ABORT"
      };
    }
  }

  private enforceGuardrails(decision: AgentDecision, input: AgentInput): AgentDecision {
    if (!decision || !decision.action) {
      log.warn("Model returned empty or invalid decision. Falling back to default retry guardrail.");
      return {
        diagnosis: "Fallback: AI model returned invalid decision",
        confidence: "low",
        action: "RETRY",
        params: {
          new_tip_lamports: Math.round((input.bundle?.tip_lamports || 1000) * 1.5),
          refresh_blockhash: true
        }
      };
    }

    if (decision.params?.new_tip_lamports && input.network?.remaining_tip_budget_lamports) {
      if (decision.params.new_tip_lamports > input.network.remaining_tip_budget_lamports) {
        return {
          diagnosis: "Budget exceeded guardrail triggered",
          confidence: "high",
          action: "ABORT"
        };
      }
    }
    
    if (decision.params?.submit_at_slot && input.network?.current_slot) {
        if (decision.params.submit_at_slot < input.network.current_slot) {
            decision.params.submit_at_slot = input.network.current_slot + 1;
        }
    }

    if (input.bundle && input.bundle.attempt >= 3 && (decision.action === "RETRY" || decision.action === "HOLD")) {
      return {
        diagnosis: `Forced public RPC fallback guardrail triggered after attempt ${input.bundle.attempt}`,
        confidence: "high",
        action: "FALLBACK_RPC"
      };
    }

    return decision;
  }
}
