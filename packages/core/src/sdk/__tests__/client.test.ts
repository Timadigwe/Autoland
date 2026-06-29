import { describe, it, expect } from "vitest";
import { AutoLand } from "../client.js";
import { Connection, Keypair } from "@solana/web3.js";

describe("AutoLand EventEmitter", () => {
  it("should extend EventEmitter and successfully listen/emit events", () => {
    const mockConnection = {
      getLatestBlockhash: async () => ({ blockhash: "hash", lastValidBlockHeight: 100 }),
      getSlot: async () => 100,
    } as unknown as Connection;
    const mockWallet = Keypair.generate();

    const client = new AutoLand({
      connection: mockConnection,
      wallet: mockWallet,
      submit: false
    });

    let receivedTelemetry = false;
    let telemetryPayload: any = null;

    client.on("telemetry_update", (payload) => {
      receivedTelemetry = true;
      telemetryPayload = payload;
    });

    // Test direct emit
    client.emit("telemetry_update", { slot: 42, alphaContention: 1.5 });

    expect(receivedTelemetry).toBe(true);
    expect(telemetryPayload).toEqual({ slot: 42, alphaContention: 1.5 });
  });
});
