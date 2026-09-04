import type { NextConfig } from 'next';
import path from 'node:path';
const nextConfig: NextConfig = {
  // VoidDEX intentionally consumes the same public deployment record and
  // sponsored-receipt verifier as VoidScan. Root the build at the repository
  // explicitly so Turbopack permits those two reviewed cross-app imports.
  turbopack: { root: path.resolve(process.cwd(), '..') },
};
export default nextConfig;
