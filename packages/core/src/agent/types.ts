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
  action: 'RETRY' | 'HOLD' | 'ABORT';
  params?: {
    submit_at_slot?: number;
    new_tip_lamports?: number;
    refresh_blockhash?: boolean;
  };
}
