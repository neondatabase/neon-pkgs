import chalk from "chalk";
import type { BootstrapTemplate } from "./bootstrap.js";

export const SKIP_TEMPLATE_VALUE = "skip" as const;

/**
 * The picker label for a template: the title first, then the Neon services it
 * uses as a dim, italic suffix. The suffix is styled with chalk.dim (and italic)
 * only — never a foreground color — so it survives the cyan/underline `prompts`
 * paints over the focused row.
 */
export const formatTemplateTitle = (template: BootstrapTemplate): string => {
	if (!template.services || template.services.length === 0) {
		return template.title;
	}
	return `${template.title}  ${chalk.dim.italic(template.services.join(" · "))}`;
};
