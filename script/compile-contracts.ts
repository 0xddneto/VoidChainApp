/**
 * Builds the deployable Solidity artifacts without depending on a global
 * Foundry installation. `deploy-testnet.ts` consumes these files; CI still
 * runs Foundry's full build and test suite.
 *
 * Usage: npm run build:contracts
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import solc from 'solc';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const contractsRoot = resolve(root, 'contracts');
const out = resolve(root, 'out');

function solidityFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = resolve(directory, entry.name);
    if (entry.isDirectory()) return solidityFiles(full);
    return entry.isFile() && entry.name.endsWith('.sol') ? [full] : [];
  });
}

const sources = Object.fromEntries(
  solidityFiles(contractsRoot).map((file) => {
    const name = relative(root, file).replaceAll('\\', '/');
    return [name, { content: readFileSync(file, 'utf8') }];
  }),
);

function findImport(importPath: string): { contents?: string; error?: string } {
  const candidates = [
    resolve(root, importPath),
    resolve(root, 'node_modules', importPath),
    resolve(root, 'lib', importPath),
  ];
  for (const candidate of candidates) {
    try { return { contents: readFileSync(candidate, 'utf8') }; } catch {}
  }
  return { error: `Import not found: ${importPath}` };
}

const input = {
  language: 'Solidity',
  sources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: 'shanghai',
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'metadata'] } },
  },
};

const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImport })) as {
  errors?: Array<{ severity: string; formattedMessage: string }>;
  contracts?: Record<string, Record<string, {
    abi: unknown;
    evm: { bytecode: { object: string }; deployedBytecode: { object: string } };
    metadata: string;
  }>>;
};
const errors = output.errors?.filter((issue) => issue.severity === 'error') ?? [];
if (errors.length > 0) {
  errors.forEach((issue) => console.error(issue.formattedMessage));
  process.exitCode = 1;
} else if (!output.contracts) {
  throw new Error('Solidity returned no contracts.');
} else {
  // Artifacts are generated build output. Clear only this ignored directory,
  // never source or deployment records.
  rmSync(out, { recursive: true, force: true });
  for (const [source, contracts] of Object.entries(output.contracts)) {
    const sourceFolder = basename(source);
    for (const [name, artifact] of Object.entries(contracts)) {
      // EIP-170 rejects contracts at or above 24 KiB. The Paymaster is the
      // contract most likely to grow because its signature surface is explicit;
      // fail the reproducible build before a deployment consumes testnet ETH.
      if (name === 'VoidPaymaster' && artifact.evm.deployedBytecode.object.length / 2 >= 24_576) {
        throw new Error(`VoidPaymaster runtime bytecode is too large for EIP-170 (${artifact.evm.deployedBytecode.object.length / 2} bytes).`);
      }
      const target = resolve(out, sourceFolder, `${name}.json`);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, JSON.stringify({
        abi: artifact.abi,
        bytecode: { object: artifact.evm.bytecode.object },
        deployedBytecode: { object: artifact.evm.deployedBytecode.object },
        metadata: artifact.metadata,
      }, null, 2));
    }
  }
  console.log(`Built ${Object.keys(output.contracts).length} Solidity source groups with solc ${solc.version()}.`);
}
