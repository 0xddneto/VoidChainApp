import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The repository has a lockfile for contracts and another for the web app.
  // Keep Turbopack rooted here so it does not guess the parent as a workspace
  // and accidentally watch or resolve the Solidity dependencies.
  turbopack: {
    root: process.cwd(),
  },
};

export default nextConfig;
