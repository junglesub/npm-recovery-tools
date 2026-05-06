# npm-recovery-tools

Small standalone tools for recovering Nginx Proxy Manager host configs from `database.sqlite`, plus a Windows fallback that types file contents into the currently focused input.

## Included tools

- `scripts/rebuild-host-configs.js`
  Rebuilds `proxy_host/*.conf` and `redirection_host/*.conf` by reading `database.sqlite`.
- `scripts/type-at-cursor-windows.js`
  Waits a few seconds, then types the contents of a text file at the current cursor position on Windows.

## Repository layout

```text
npm-recovery-tools/
  package.json
  README.md
  scripts/
    rebuild-host-configs.js
    type-at-cursor-windows.js
    input.txt
```

## Install

```bash
npm install
```

## 1. Rebuild NPM host configs

Rebuild from `database.sqlite` into an `nginx` folder:

```bash
node ./scripts/rebuild-host-configs.js --db /path/to/database.sqlite --output /path/to/nginx
```

If `--output` is omitted, the script creates `nginx/` next to the database file.

Dry run:

```bash
node ./scripts/rebuild-host-configs.js --db /path/to/database.sqlite --dry-run
```

## 2. Type file contents at cursor on Windows

Put the text you want to type into `scripts/input.txt`, then run:

```powershell
node .\scripts\type-at-cursor-windows.js --file .\scripts\input.txt --delay 3000 --interval 80
```

After starting the command, click the target terminal or input box before the delay ends. The file content will be typed into the focused window.

## Example server flow

When copy/paste is available on the server:

```bash
curl -L "https://raw.githubusercontent.com/junglesub/npm-recovery-tools/main/scripts/rebuild-host-configs.js" -o rebuild-host-configs.js
npm init -y
npm install better-sqlite3 liquidjs
node ./rebuild-host-configs.js --db /data/database.sqlite --output /data/nginx
```

When copy/paste is not available and you need a Windows typing fallback:

```powershell
node .\scripts\type-at-cursor-windows.js --file .\scripts\input.txt
```

## Download URLs

- Raw rebuild script:
  `https://raw.githubusercontent.com/junglesub/npm-recovery-tools/main/scripts/rebuild-host-configs.js`
- Raw Windows typing script:
  `https://raw.githubusercontent.com/junglesub/npm-recovery-tools/main/scripts/type-at-cursor-windows.js`
- Raw sample input file:
  `https://raw.githubusercontent.com/junglesub/npm-recovery-tools/main/scripts/input.txt`

## Notes

- `rebuild-host-configs.js` is standalone in the sense that it does not read local template files. Its templates are embedded in the script.
- The rebuild script still depends on `better-sqlite3` and `liquidjs`.
- The Windows typing helper uses PowerShell and `WScript.Shell.SendKeys`, so the target window must remain focused.
