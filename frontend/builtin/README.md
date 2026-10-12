# Local payload defaults

Only `payloads.json` ships with the application. Its entries define startup
payload downloads and remain editable through the catalog editor.

Input scripts and Autoload templates now live in `store/scripts/` and
`store/templates/`. `node scripts/build-store-index.mjs` validates these
items and generates `store/builtin/inputScripts.json` and
`store/builtin/templates.json` for runtime loading from Marketplace.
They are not copied into Docker or Windows application packages.

Legacy `builtin:*` script ids and `tpl-*` template ids remain stable.
Downloaded catalogs and field-level local overrides persist under
`DATA_DIR/marketplace`. A refresh preserves local edits. A first run needs
Marketplace connectivity; later reads can use the last validated catalog
offline. See `store/README.md` for configuration and update behavior.
