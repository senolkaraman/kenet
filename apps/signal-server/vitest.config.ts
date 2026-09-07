import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// `@kenet/protocol` publishes its runtime entry as ./dist/index.js, which does not exist on a
// fresh checkout (dist/ is gitignored and only built as part of the root build). The package is
// pure TypeScript — types plus one const table — so point the test runner straight at the source
// and skip the build-order dependency entirely. Production (`node dist/index.js`) and the bundled
// builds still resolve the compiled dist via the package's own `main`/`exports`.
export default defineConfig({
  resolve: {
    alias: {
      "@kenet/protocol": fileURLToPath(new URL("../../packages/protocol/src/index.ts", import.meta.url))
    }
  }
});
