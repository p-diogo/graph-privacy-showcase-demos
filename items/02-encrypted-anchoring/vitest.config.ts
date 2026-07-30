import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
    // tests/subgraph is AssemblyScript run by matchstick (`graph test`), and
    // tests/integration needs a local chain + graph-node stack. Neither belongs
    // to `pnpm test`, which must be meaningful on a bare checkout.
    exclude: ["node_modules/**", "dist/**", "tests/integration/**", "tests/subgraph/**"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
