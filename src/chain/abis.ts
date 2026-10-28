import { parseAbi } from 'viem';

// Morpho Chainlink oracle V2 and the Steakhouse MetaOracle: only the getters the decoder reads.
export const oracleAbi = parseAbi([
  'function BASE_FEED_1() view returns (address)',
  'function BASE_FEED_2() view returns (address)',
  'function BASE_VAULT() view returns (address)',
  'function QUOTE_FEED_1() view returns (address)',
  'function QUOTE_FEED_2() view returns (address)',
  'function QUOTE_VAULT() view returns (address)',
  'function primaryOracle() view returns (address)',
  'function backupOracle() view returns (address)',
  'function challengeTimelockDuration() view returns (uint256)',
  'function isChallenged() view returns (bool)',
  'function isBackup() view returns (bool)',
  'function isHealing() view returns (bool)',
  'function challengeExpiresAt() view returns (uint256)',
]);

export const MORPHO = '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb' as const;

export const morphoAbi = parseAbi([
  'function idToMarketParams(bytes32 id) view returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)',
  'function position(bytes32 id, address user) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)',
  'function market(bytes32 id) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)',
]);

export const vaultV2Abi = parseAbi([
  'function name() view returns (string)',
  'function asset() view returns (address)',
  'function totalAssets() view returns (uint256)',
  'function adaptersLength() view returns (uint256)',
  'function adapters(uint256 index) view returns (address)',
]);

export const marketAdapterAbi = parseAbi([
  'function marketIdsLength() view returns (uint256)',
  'function marketIds(uint256 index) view returns (bytes32)',
  'function expectedSupplyAssets(bytes32 marketId) view returns (uint256)',
]);

export const vaultAdapterAbi = parseAbi([
  'function morphoVaultV1() view returns (address)',
  'function realAssets() view returns (uint256)',
]);

export const vaultV1Abi = parseAbi([
  'function withdrawQueueLength() view returns (uint256)',
  'function withdrawQueue(uint256 index) view returns (bytes32)',
]);

export const erc20Abi = parseAbi([
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
]);
