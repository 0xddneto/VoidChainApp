import 'dotenv/config';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createPublicClient, fallback, http, parseAbi } from 'viem';

const source = JSON.parse(readFileSync('../web/lib/deployment.json', 'utf8'));
const path = 'deployments/testnet-v8-snapshot.json';
if (existsSync(path)) throw Error('V8 snapshot already exists; never replace an ownership cutoff.');
const urls = [process.env.PARENT_RPC, source.network.rpc, 'https://rpc.testnet.chain.robinhood.com'].filter(Boolean) as string[];
const rpc = createPublicClient({ transport: fallback(urls.map((url) => http(url))) });
if (await rpc.getChainId() !== 46630) throw Error('Testnet only');

const block = await rpc.getBlock();
const mintAbi = parseAbi(['function totalMinted() view returns(uint256)']);
const deedAbi = parseAbi([
  'function ownerOf(uint256) view returns(address)',
  'function identityOf(uint256) view returns((string name,string description,string imageURI,string externalURL,string[] socials))',
]);
const runtimeAbi = parseAbi(['function statsOf(uint256) view returns(bool,uint256,uint256,uint256,uint256)']);
const minted = await rpc.readContract({ address: source.production.VoidEthGenesisMintV6, abi: mintAbi, functionName: 'totalMinted', blockNumber: block.number });
if (minted === 0n || minted > 1111n) throw Error(`Invalid minted supply ${minted}`);

const deeds = [];
for (let id = 1n; id <= minted; id++) {
  const [owner, identity, stats] = await Promise.all([
    rpc.readContract({ address: source.production.VoidChainDeed, abi: deedAbi, functionName: 'ownerOf', args: [id], blockNumber: block.number }),
    rpc.readContract({ address: source.production.VoidChainDeed, abi: deedAbi, functionName: 'identityOf', args: [id], blockNumber: block.number }),
    rpc.readContract({ address: source.production.VoidChainAppRuntime, abi: runtimeAbi, functionName: 'statsOf', args: [id], blockNumber: block.number }),
  ]);
  deeds.push({
    id,
    owner,
    identity,
    stats,
    inLegacyPool: owner.toLowerCase() === source.testnet.VoidGenesisNftAmmV6.toLowerCase(),
  });
}

const snapshot = {
  version: 'v8-security-migration',
  network: 46630,
  block: block.number,
  blockHash: block.hash,
  source,
  deeds,
  policy: 'Preserve every minted ID, owner, identity and active-chain fee at one immutable block. Old contracts remain readable.',
};
writeFileSync(path, JSON.stringify(snapshot, (_key, value) => typeof value === 'bigint' ? value.toString() : value, 2) + '\n');
console.log(JSON.stringify({ block: String(block.number), minted: String(minted), blockHash: block.hash }, null, 2));
