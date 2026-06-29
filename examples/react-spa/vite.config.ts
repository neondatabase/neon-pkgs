import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { postgres } from "vite-plugin-neon-new";

export default defineConfig({
	plugins: [
		postgres({
			referrer: "github:neondb-cli/examples/react-spa",
		}),
		react(),
	],
});
