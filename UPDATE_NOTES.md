# Gallery++ v1.6.3 — Loading fix

This build fixes the extension-load failure caused by relative imports that were one directory too shallow for SillyTavern's third-party extension mount. It also fixes asset lookup by resolving nanogallery2 files relative to `import.meta.url`.

## Apply to the GitHub repository

Extract this package and upload its files directly to the repository root, replacing matching files. Keep the repository's existing `LICENSE` and `NOTICE.md` unchanged. Commit and push the changes, then in SillyTavern update/reinstall Gallery++ from the repository and reload the page.

This package is intended to be overlaid onto the existing repository; it deliberately does not replace `LICENSE` or `NOTICE.md`.
