import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      include: ["apps/*/src/**/*.ts", "packages/*/src/**/*.ts", "services/*/src/**/*.ts"],
      provider: "v8",
      reporter: ["text", "json-summary"],
    },
    include: ["{apps,packages,services}/*/src/**/*.test.ts"],
  },
});
