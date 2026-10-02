import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Next allows one dev server per build folder. The end-to-end tests set NEXT_DIST_DIR to a folder of
  // their own, so they can start the admin console while a developer's own `next dev` is running
  // (the same promise the test ports make for everything else); nothing else sets it.
  distDir: process.env.NEXT_DIST_DIR || '.next',
  reactStrictMode: true,
  transpilePackages: ['@ridemesh/config', '@ridemesh/firebase', '@ridemesh/ui'],
};

export default nextConfig;
