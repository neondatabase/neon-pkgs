import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const source = new URL("../src/callback.html", import.meta.url);
const output = new URL("../dist/", import.meta.url);
const mimeTypes = { svg: "image/svg+xml", woff2: "font/woff2" };
const css = readFileSync(
	new URL("../src/callback.css", import.meta.url),
	"utf8",
);
const template = readFileSync(source, "utf8");
const stylesheetLink =
	/<link\s+rel="stylesheet"\s+href="\.\/callback\.css"\s*\/?>/;

if (!stylesheetLink.test(template)) {
	throw new Error("Missing callback.css stylesheet link in callback.html");
}
if (!css.trim()) {
	throw new Error("Empty callback stylesheet");
}

// The OAuth server closes after sending the callback. Ship a single document
// so styles, images and fonts load without another request (including in binaries).
const html = template
	.replace(stylesheetLink, () => `<style>\n${css}</style>`)
	.replace(
		/\.\/callback-assets\/[\w.-]+\.(svg|woff2)/g,
		(path, extension) => {
			const asset = readFileSync(new URL(path, source));
			if (asset.length === 0)
				throw new Error(`Empty callback asset: ${path}`);
			return `data:${mimeTypes[extension]};base64,${asset.toString("base64")}`;
		},
	);
const fontLicense = readFileSync(
	new URL("../src/callback-assets/INTER-LICENSE.txt", import.meta.url),
	"utf8",
);

mkdirSync(output, { recursive: true });
writeFileSync(
	new URL("callback.html", output),
	`${html}\n<!-- Inter font license:\n${fontLicense}\n-->\n`,
);
