// Records real eth_call answers for the oracle getters at one Base block, so tests run offline.
// Usage: node --env-file=.env --import tsx scripts/record-oracle-fixtures.ts
import { writeFileSync } from 'node:fs';
import { createPublicClient, encodeFunctionData, http } from 'viem';
import { base } from 'viem/chains';
import { oracleAbi } from '../src/chain/abis.js';

const ORACLES = [
  '0xF4b17C79492d68775e22e8Dd0a2Bb22854A39A47', // USDe/USDC MetaOracle
  '0xf243538bc89634b0abb5686a5b72e21282a54695', // its primary
  '0x995aed0fa3dbe02fa1efa50f65ea57dc0b3dcf6a', // its backup
  '0x663BECd10daE6C4A3Dcd89F1d76c1174199639B9', // cbBTC/USDC Chainlink oracle
] as const;

const client = createPublicClient({ chain: base, transport: http(process.env.RPC_URL) });
const block = (await client.getBlockNumber()) - 100n;
const calls: Record<string, string | null> = {};
for (const to of ORACLES) {
  for (const item of oracleAbi) {
    const data = encodeFunctionData({ abi: oracleAbi, functionName: item.name } as never);
    try {
      const r = await client.call({ to, data, blockNumber: block });
      calls[`${to.toLowerCase()}:${data}`] = r.data ?? null;
    } catch {
      calls[`${to.toLowerCase()}:${data}`] = null; // revert = the contract has no such getter
    }
  }
}
writeFileSync('test/fixtures/oracles.json', JSON.stringify({ block: block.toString(), calls }, null, 2));
console.log(`recorded ${Object.keys(calls).length} calls at block ${block}`);
