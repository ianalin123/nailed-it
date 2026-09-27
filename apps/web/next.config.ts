import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@nailed-it/protocol"],
  reactStrictMode: true,
};

export default nextConfig;
