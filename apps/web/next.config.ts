import type { NextConfig } from "next";

const backendOrigin =
  process.env.REDIRECT_SERVICE_ORIGIN ?? "http://127.0.0.1:3000";

const config: NextConfig = {
  agentRules: false,
  devIndicators: false,
  async rewrites() {
    return [
      {
        source: "/graphql",
        destination: new URL("/graphql", backendOrigin).href,
      },
    ];
  },
};

export default config;
