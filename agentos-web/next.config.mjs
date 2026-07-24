/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Produces a minimal self-contained server bundle in .next/standalone —
  // required for the multi-stage Docker build (see Dockerfile).
  output: 'standalone'
};

export default nextConfig;
