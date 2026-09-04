/** Produces a private staging manifest, never switches the public frontend. */
import {readFileSync,writeFileSync} from 'node:fs';
const staged=JSON.parse(readFileSync('deployments/testnet-v7-pending.json','utf8'));
const previous=JSON.parse(readFileSync('deployments/testnet-v7-snapshot.json','utf8')).source;
const c=staged.contracts;
const next={...previous,version:'v7-migrated-eth-genesis-testnet',network:staged.network,
 production:{VoidChainDeed:c.deed,VoidChainTreasury:c.treasury,VoidChainAppRuntime:c.runtime,VoidPaymaster:c.paymaster,VoidChainDaoFactory:c.daoFactory,VoidChainAppFactoryV3:c.appFactory,VoidEthGenesisMintV6:c.mint},
 testnet:{VoidTestToken:c.token,VoidGenesisEscrowV6:c.escrow,VoidEthPoolV6:c.pool,VoidTwapOracleV6:c.twap,VoidTwapFreshnessGuardV6:c.oracle,VoidGenesisNftAmmV6:c.nftAmm},parameters:{...previous.parameters,inPool:1}};
writeFileSync('deployments/testnet-v7-site.json',JSON.stringify(next,null,2)+'\n');
console.log('Staging manifest ready. Public manifests unchanged.');
