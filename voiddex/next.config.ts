import type { NextConfig } from 'next';
import path from 'node:path';

const securityHeaders = [
  {
    key: 'Content-Security-Policy',
    value: [
      "default-src 'self'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "object-src 'none'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https:",
      "font-src 'self' data:",
      "connect-src 'self' https://robinhood-testnet.drpc.org https://rpc.testnet.chain.robinhood.com",
      "upgrade-insecure-requests",
    ].join('; '),
  },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
] as const;

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // VoidDEX intentionally consumes the same public deployment record and
  // sponsored-receipt verifier as VoidScan. Root the build at the repository
  // explicitly so Turbopack permits those two reviewed cross-app imports.
  turbopack: { root: path.resolve(process.cwd(), '..') },
  async headers() {
    return [{ source: '/(.*)', headers: [...securityHeaders] }];
  },
};
export default nextConfig;
