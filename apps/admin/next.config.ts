import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@ridemesh/config', '@ridemesh/ui'],
};

export default nextConfig;
