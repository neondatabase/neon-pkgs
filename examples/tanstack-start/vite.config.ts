import { postgres } from "vite-plugin-neon-new";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { defineConfig } from "vite";
import viteTsConfigPaths from "vite-tsconfig-paths";

const config = defineConfig({
  plugins: [
    postgres({
      seed: {
        type: "sql-script",
        path: "./db/init.sql",
      },
      referrer: "github:neondb-cli/examples/tanstack-start",
    }),
    // this is the plugin that enables path aliases
    viteTsConfigPaths({
      projects: ["./tsconfig.json"],
    }),
    tailwindcss(),
    tanstackStart(),
  ],
});

export default config;
