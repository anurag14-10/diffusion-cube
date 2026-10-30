import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false,
  // Emits .next/standalone (a self-contained node server) so the Docker
  // image used on AWS doesn't need node_modules or the Next CLI at runtime.
  // Harmless on Vercel, which ignores it.
  output: "standalone",
  // Pin the workspace root to this repo. Otherwise Next infers it from the
  // nearest lockfile, and a stray one in a parent directory (e.g. ~) makes
  // Turbopack treat that as the root — breaking the RSC client manifest in
  // dev and nesting the standalone output under the wrong path.
  turbopack: { root: __dirname },
  outputFileTracingRoot: __dirname,
};

export default nextConfig;
