import { postgres } from "vite-plugin-neon-new";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [
		postgres({
			referrer: "github:neondb-cli/examples/react-spa",
		}),
		react(),
	],
});
