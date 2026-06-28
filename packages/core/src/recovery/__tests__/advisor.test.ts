import { describe, it, expect, vi } from "vitest";
import { Agent } from "../advisor.js";
import type { AgentInput } from "../advisor.js";

vi.mock("../../dispatch/fees.js", () => {
  return {
    tipFloorService: () => {
      return {
        get: async () => {
          return {
            p25: 2000,
            p50: 5000,
            p75: 10000,
            p95: 20000,
            p99: 50000,
            ema: 5000,
            fetchedAt: Date.now()
          };
        }
      };
    }
  };
});

vi.mock("openai", () => {
  return {
    OpenAI: class {
      chat = {
        completions: {
          create: async (params: any) => {
            const userMsg = params.messages.find((m: any) => m.role === "user");
            const input = JSON.parse(userMsg.content);

            if (input.test_tool_calling && params.messages.length === 2) {
              return {
                choices: [
                  {
                    message: {
                      content: null,
                      tool_calls: [
                        {
                          id: "call-test-1",
                          type: "function",
                          function: {
                            name: "get_tip_percentile_info",
                            arguments: JSON.stringify({ tipLamports: 15000 })
                          }
                        }
                      ]
                    }
                  }
                ]
              };
            }

            if (input.test_tool_calling && params.messages.length > 2) {
              const toolMsg = params.messages.find((m: any) => m.role === "tool");
              const toolContent = JSON.parse(toolMsg?.content || "{}");
              return {
                choices: [
                  {
                    message: {
                      content: JSON.stringify({
                        diagnosis: `Tool returned percentile range: ${toolContent.percentileRange}. Deciding to retry with a higher tip.`,
                        confidence: "high",
                        action: "RETRY",
                        params: {
                          new_tip_lamports: 35000
                        }
                      })
                    }
                  }
                ]
              };
            }

            if (input.failure?.type === "jito_api_error") {
              return {
                choices: [
                  {
                    message: {
                      content: JSON.stringify({
                        diagnosis: "Jito API rate limit or error detected, falling back to public RPC",
                        confidence: "high",
                        action: "FALLBACK_RPC"
                      })
                    }
                  }
                ]
              };
            }

            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      diagnosis: "Standard failure",
                      confidence: "high",
                      action: "RETRY"
                    })
                  }
                }
              ]
            };
          }
        }
      };
    }
  };
});

vi.mock("../db.js", () => {
  return {
    db: {
      recordDecision: vi.fn(),
      getRecentLifecycles: vi.fn().mockResolvedValue([{ bundle_id: "test-recent", failure_type: "bundle_dropped" }]),
      getRecentDecisions: vi.fn().mockResolvedValue([{ bundle_id: "test-recent", decision: "RETRY" }]),
    }
  };
});

describe("Agent", () => {
  it("decides FALLBACK_RPC when failure type is jito_api_error", async () => {
    const agent = new Agent();
    const input: AgentInput = {
      event: "bundle_failed",
      failure: {
        type: "jito_api_error",
        detectedAtSlot: 100,
        ts: new Date().toISOString(),
        evidence: {
          reason: "HTTP 429 Too Many Requests"
        }
      },
      bundle: {
        attempt: 1,
        tip_lamports: 1000,
        tip_account: "tip_account",
        submitted_slot: 100,
        target_leader_slot: 104
      }
    };

    const decision = await agent.evaluate(input);
    expect(decision.action).toBe("FALLBACK_RPC");
    expect(decision.diagnosis).toContain("Jito API rate limit");
  });

  it("forces FALLBACK_RPC via guardrail after 2 failed retries (attempt >= 3)", async () => {
    const agent = new Agent();
    const input: AgentInput = {
      event: "bundle_failed",
      failure: {
        type: "bundle_dropped",
        detectedAtSlot: 100,
        ts: new Date().toISOString(),
        evidence: {
          reason: "congestion"
        }
      },
      bundle: {
        attempt: 3,
        tip_lamports: 1000,
        tip_account: "tip_account",
        submitted_slot: 100,
        target_leader_slot: 104
      }
    };

    const decision = await agent.evaluate(input);
    expect(decision.action).toBe("FALLBACK_RPC");
    expect(decision.diagnosis).toContain("Forced public RPC fallback guardrail triggered");
  });

  it("does not force FALLBACK_RPC on the first retry (attempt = 2)", async () => {
    const agent = new Agent();
    const input: AgentInput = {
      event: "bundle_failed",
      failure: {
        type: "bundle_dropped",
        detectedAtSlot: 100,
        ts: new Date().toISOString(),
        evidence: {
          reason: "congestion"
        }
      },
      bundle: {
        attempt: 2,
        tip_lamports: 1000,
        tip_account: "tip_account",
        submitted_slot: 100,
        target_leader_slot: 104
      }
    };

    const decision = await agent.evaluate(input);
    expect(decision.action).toBe("RETRY");
  });

  it("executes autonomous tool calling successfully", async () => {
    const agent = new Agent();
    const input: any = {
      test_tool_calling: true,
      event: "bundle_failed",
      failure: {
        type: "bundle_dropped",
        detectedAtSlot: 100,
        ts: new Date().toISOString(),
        evidence: {
          reason: "congestion"
        }
      },
      bundle: {
        attempt: 1,
        tip_lamports: 15000,
        tip_account: "tip_account",
        submitted_slot: 100,
        target_leader_slot: 104
      }
    };

    const decision = await agent.evaluate(input);
    expect(decision.action).toBe("RETRY");
    expect(decision.diagnosis).toContain("Tool returned percentile range: p75-p95");
    expect(decision.params?.new_tip_lamports).toBe(35000);
  });
});
