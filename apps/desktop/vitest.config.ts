import { defineConfig } from "vitest/config";

// Renderer logic that is pure (wire framing, rate control, negotiation) is unit-tested here.
// WebCodecs / DOM APIs are not available under Node — those modules are integration-tested in
// the running app, and their pure helpers are split out so they can be covered here.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node"
  }
});
