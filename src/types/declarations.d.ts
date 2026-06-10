// Type declarations for packages without official types

declare module 'bs58' {
  export function encode(buffer: Uint8Array): string;
  export function decode(string: string): Uint8Array;
}

declare module 'bn.js' {
  export class BN {
    constructor(value: string | number | Uint8Array | Buffer | BN, base?: number);
    toString(base?: number): string;
    toNumber(): number;
    toArray(endian?: string, length?: number): number[];
    static isBN(object: any): object is BN;
  }
  export = BN;
}

declare module '@shyft-to/solana-transaction-parser' {
  import { PublicKey, VersionedTransactionResponse } from '@solana/web3.js';
  import { Idl } from '@coral-xyz/anchor';

  export class SolanaParser {
    constructor(parsers: any[]);
    addParserFromIdl(programId: string, idl: Idl): void;
    parseTransactionData(message: any, loadedAddresses: any): any[];
    parseTransactionWithInnerInstructions(transaction: VersionedTransactionResponse): any[];
  }
}