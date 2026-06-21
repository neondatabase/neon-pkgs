---
"neon-init": minor
---

Bring the full template bootstrap implementation into `neon-init` and expose it via a new `neon-init/bootstrap` entry point.

Previously `neon-init` only knew how to read the template manifest and shelled out to `npx -y neonctl@latest bootstrap` to actually scaffold a project. The manifest layer has been replaced with the complete, in-house implementation (manifest fetch/parse, single-request `codeload.github.com` tarball download, in-house gunzip + tar parsing, and on-disk scaffolding with exec-bit and symlink fidelity), so the interactive and agent setup flows now scaffold in-process — no global `neonctl` and no `npx` round-trip required.

The new `neon-init/bootstrap` export ships `fetchTemplates`, `parseManifest`, `downloadTemplate`, `scaffoldTemplate`, `ensureTargetUsable`, `BootstrapInputError`, `FALLBACK_TEMPLATES`, and the `BootstrapTemplate` / `TemplateFile` / `NeonFeature` types. `BootstrapTemplate` now carries both `services` (display badge) and `requires` (Neon features) so it is a superset of the previous shape.
