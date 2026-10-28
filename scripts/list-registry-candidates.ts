// Lists the tokens and feeds reached by the tracked vaults, to pre-fill registry/*.json by hand.
// description() is only a hint for the registry PR; the registry decides what a feed means.
// Usage: node --env-file=.env --import tsx scripts/list-registry-candidates.ts <vault> [<vault>...]
import { zeroAddress } from 'viem';
import { decodeOracle } from '../src/chain/oracleDecoder.js';
import { readMarket } from '../src/chain/marketReader.js';
import { readToken, readVault } from '../src/chain/vaultReader.js';
import { read } from '../src/chain/call.js';
import { parseAbi } from 'viem';
import type { Address, DecodedOracle } from '../src/types.js';
import { createViemReader } from '../src/chain/reader.js';

const reader = createViemReader(process.env.RPC_URL as string);
const feedAbi = parseAbi(['function description() view returns (string)', 'function decimals() view returns (uint8)']);
const block = (await reader.blockNumber()) - 5n;
const seen = new Set<string>();

async function describeOracle(o: DecodedOracle, indent: string): Promise<void> {
  if (o.class === 'metaoracle') {
    console.log(`${indent}metaoracle ${o.address} state=${o.state} challenge=${o.challengeSeconds}s`);
    await describeOracle(o.primary, indent + '  primary: ');
    await describeOracle(o.backup, indent + '  backup: ');
  } else if (o.class === 'chainlink') {
    for (const f of o.feeds) {
      const d = await read<string>(reader, f, feedAbi, 'description', [], block);
      console.log(`${indent}feed ${f} "${d ?? '?'}"`);
    }
    if (o.feeds.length === 0) console.log(`${indent}no feed (ERC4626 base vault)`);
  } else console.log(`${indent}${o.class} ${o.address}${o.class === 'unknown' ? ' ' + o.reason : ''}`);
}

for (const vault of process.argv.slice(2) as Address[]) {
  const v = await readVault(reader, vault, block);
  console.log(`\n## ${v.name} ${vault} total=${v.totalAssets} unknownAdapters=${v.unknownAdapters.length}`);
  for (const p of v.positions) {
    const m = await readMarket(reader, p.marketId, block);
    if (!m || m.collateral === zeroAddress) continue;
    const t = await readToken(reader, m.collateral);
    const share = Number((p.assets * 10000n) / v.totalAssets) / 100;
    console.log(`- ${t.symbol} (${m.collateral}) lltv=${Number(m.lltv) / 1e16}% share=${share}% oracle=${m.oracle}`);
    if (!seen.has(m.oracle)) { seen.add(m.oracle); await describeOracle(await decodeOracle(reader, m.oracle, block), '    '); }
  }
}
