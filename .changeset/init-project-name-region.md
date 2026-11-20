---
"neon": patch
---

`neon init -y --project-name <name>` without `--region-id` (or `--region-id` without `--project-name`) now fails before it installs anything. It used to install the plugin or skills first and then fail in the link step, so the retry ran the whole setup again. The error now says to add the missing flag to the same `neon init` command; it used to show a `neon link` command. With `--branch`, the existing conflict error from the link step is unchanged. `neon init --help` now says that `--project-name` and `--region-id` go together, and has an example that creates and links a project.
