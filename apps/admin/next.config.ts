import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@ridemesh/config', '@ridemesh/firebase', '@ridemesh/ui'],
};

export default nextConfig;
