// Simple export of IDL for the market maker bot
// Using actual Meteora program structure for pool creation detection

export const METEORA_IDL = {
  version: "0.5.3",
  name: "amm",
  instructions: [
    {
      name: "initializePermissionedPool",
      accounts: [
        { name: "pool", isMut: true, isSigner: true },
        { name: "lpMint", isMut: true, isSigner: false },
        { name: "tokenAMint", isMut: false, isSigner: false },
        { name: "tokenBMint", isMut: false, isSigner: false },
        { name: "aVault", isMut: true, isSigner: false },
        { name: "bVault", isMut: true, isSigner: false },
        { name: "aTokenVault", isMut: true, isSigner: false },
        { name: "bTokenVault", isMut: true, isSigner: false },
        { name: "aVaultLpMint", isMut: true, isSigner: false },
        { name: "bVaultLpMint", isMut: true, isSigner: false },
        { name: "payerTokenA", isMut: true, isSigner: false },
        { name: "payerTokenB", isMut: true, isSigner: false },
        { name: "payerPoolLp", isMut: true, isSigner: false },
        { name: "protocolTokenAFee", isMut: true, isSigner: false },
        { name: "protocolTokenBFee", isMut: true, isSigner: false },
        { name: "payer", isMut: true, isSigner: true },
        { name: "feeOwner", isMut: false, isSigner: false },
        { name: "rent", isMut: false, isSigner: false },
        { name: "mintMetadata", isMut: true, isSigner: false },
        { name: "metadataProgram", isMut: false, isSigner: false },
        { name: "vaultProgram", isMut: false, isSigner: false },
        { name: "tokenProgram", isMut: false, isSigner: false },
        { name: "associatedTokenProgram", isMut: false, isSigner: false },
        { name: "systemProgram", isMut: false, isSigner: false }
      ],
      args: [
        { name: "curveType", type: "u8" },
        { name: "stakingPoolIndex", type: "u32" },
        { name: "tradeFeeNumerator", type: "u64" },
        { name: "tradeFeeDenominator", type: "u64" },
        { name: "ownerTradeFeeNumerator", type: "u64" },
        { name: "ownerTradeFeeDenominator", type: "u64" },
        { name: "ownerWithdrawFeeNumerator", type: "u64" },
        { name: "ownerWithdrawFeeDenominator", type: "u64" },
        { name: "hostFeeNumerator", type: "u64" },
        { name: "hostFeeDenominator", type: "u64" },
        { name: "token_a_amount", type: "u64" },
        { name: "token_b_amount", type: "u64" }
      ]
    },
    {
      name: "initializePool",
      accounts: [
        { name: "pool", isMut: true, isSigner: true },
        { name: "lpMint", isMut: true, isSigner: false },
        { name: "tokenAMint", isMut: false, isSigner: false },
        { name: "tokenBMint", isMut: false, isSigner: false },
        { name: "aVault", isMut: true, isSigner: false },
        { name: "bVault", isMut: true, isSigner: false },
        { name: "aTokenVault", isMut: true, isSigner: false },
        { name: "bTokenVault", isMut: true, isSigner: false },
        { name: "aVaultLpMint", isMut: true, isSigner: false },
        { name: "bVaultLpMint", isMut: true, isSigner: false },
        { name: "payerTokenA", isMut: true, isSigner: false },
        { name: "payerTokenB", isMut: true, isSigner: false },
        { name: "payerPoolLp", isMut: true, isSigner: false },
        { name: "protocolTokenAFee", isMut: true, isSigner: false },
        { name: "protocolTokenBFee", isMut: true, isSigner: false },
        { name: "payer", isMut: true, isSigner: true },
        { name: "feeOwner", isMut: false, isSigner: false },
        { name: "rent", isMut: false, isSigner: false },
        { name: "vaultProgram", isMut: false, isSigner: false },
        { name: "tokenProgram", isMut: false, isSigner: false },
        { name: "associatedTokenProgram", isMut: false, isSigner: false },
        { name: "systemProgram", isMut: false, isSigner: false }
      ],
      args: [
        { name: "curveType", type: "u8" },
        { name: "stakingPoolIndex", type: "u32" },
        { name: "tradeFeeNumerator", type: "u64" },
        { name: "tradeFeeDenominator", type: "u64" },
        { name: "ownerTradeFeeNumerator", type: "u64" },
        { name: "ownerTradeFeeDenominator", type: "u64" },
        { name: "ownerWithdrawFeeNumerator", type: "u64" },
        { name: "ownerWithdrawFeeDenominator", type: "u64" },
        { name: "hostFeeNumerator", type: "u64" },
        { name: "hostFeeDenominator", type: "u64" },
        { name: "token_a_amount", type: "u64" },
        { name: "token_b_amount", type: "u64" }
      ]
    },
    {
      name: "swap",
      accounts: [
        { name: "pool", isMut: true, isSigner: false },
        { name: "userTokenA", isMut: true, isSigner: false },
        { name: "userTokenB", isMut: true, isSigner: false },
        { name: "aVault", isMut: true, isSigner: false },
        { name: "bVault", isMut: true, isSigner: false },
        { name: "aTokenVault", isMut: true, isSigner: false },
        { name: "bTokenVault", isMut: true, isSigner: false },
        { name: "aVaultLp", isMut: true, isSigner: false },
        { name: "bVaultLp", isMut: true, isSigner: false },
        { name: "aVaultLpMint", isMut: true, isSigner: false },
        { name: "bVaultLpMint", isMut: true, isSigner: false },
        { name: "adminTokenFee", isMut: true, isSigner: false },
        { name: "user", isMut: false, isSigner: true },
        { name: "vaultProgram", isMut: false, isSigner: false },
        { name: "tokenProgram", isMut: false, isSigner: false }
      ],
      args: [
        { name: "inAmount", type: "u64" },
        { name: "minimumOutAmount", type: "u64" }
      ]
    }
  ],
  accounts: [],
  types: [],
  events: [],
  errors: []
};