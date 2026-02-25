import { defineConfig } from "vitest/config";
import type { Plugin } from "vite";

// node:sqlite was added in Node.js 22.5.0. Vite 5.x doesn't include it in its
// list of known Node.js built-ins, so it fails to resolve it. This plugin
// intercepts the import and provides a shim that loads from Node.js at runtime.
function nodeSqlitePlugin(): Plugin {
  return {
    name: "node-sqlite-shim",
    enforce: "pre",
    resolveId(id) {
      if (id === "node:sqlite" || id === "sqlite") {
        return "\0node-sqlite-shim";
      }
    },
    load(id) {
      if (id === "\0node-sqlite-shim") {
        return `
          import { createRequire } from "node:module";
          const _require = createRequire(import.meta.url);
          const _m = _require("node:sqlite");
          export const DatabaseSync = _m.DatabaseSync;
          export const StatementSync = _m.StatementSync;
        `;
      }
    }
  };
}

export default defineConfig({
  plugins: [nodeSqlitePlugin()]
});
