import { defineConfig } from "vite";
import monkey from "vite-plugin-monkey";

export default defineConfig({
	plugins: [
		monkey({
			entry: "src/main.ts",
			userscript: {
				name: "Plarza Extension",
				namespace: "https://plarza.com",
				version: "1.1.0",
				description: "Scans web pages for URLs and uploads them to Plarza",
				author: "Plarza",
				icon: "https://plarza.com/favicon.svg",
				match: ["*://*/*"],
				exclude: [
					"*://*.plarza.com/*",
					"*://plarza.com/*",
					"*://localhost/*",
					"*://localhost:*/*",
					"*://127.0.0.1/*",
					"*://127.0.0.1:*/*",
				],
				grant: ["GM_setValue", "GM_getValue", "GM_xmlhttpRequest"],
				"run-at": "document-start",
			},
			build: {
				fileName: "plarza.user.js",
			},
		}),
	],
});
