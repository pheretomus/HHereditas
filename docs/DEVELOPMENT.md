# Developing HHereditas

HHereditas is an npm-workspaces monorepo:

| Path | What it is |
|---|---|
| `packages/core` | `@hhereditas/core` — pure-TypeScript sequence engine (file formats, enzymes, primers, cloning, gel). No DOM / Node APIs, so it runs in the desktop app, the future mobile viewer and tests alike. |
| `packages/ui` | `@hhereditas/ui` — design tokens (`src/styles/tokens.css`, light + dark) and macOS-style UI primitives. |
| `packages/viewer` | `@hhereditas/viewer` — interactive visualizations: circular map, linear map, sequence view, gel. |
| `apps/desktop` | The Tauri 2 desktop app (React 19 + Vite 8). `src-tauri/` is the thin Rust shell. |
| `tools/oracle` | Python reference implementations (Biopython, primer3, pydna) used to generate test fixtures. |
| `tools/icon` | App icon source and generator. |

## 1. One-time setup

### Ubuntu 24.04 / WSL2

```bash
# System libraries for building the Tauri app (WebKitGTK etc.) and for headless-browser screenshots
sudo apt update && sudo apt install -y build-essential pkg-config libwebkit2gtk-4.1-dev libxdo-dev \
  libssl-dev libayatana-appindicator3-dev librsvg2-dev fonts-noto-cjk \
  libnss3 libnspr4 libgbm1 xvfb fonts-liberation fonts-noto-color-emoji

# Rust (user-local, no sudo)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y

# Node.js 22+ (e.g. via nvm), then in the repo:
npm install
```

On Windows 11, WSLg displays Linux GUI windows directly, so `npm run tauri dev` opens the app window on the Windows desktop.
`libEGL`/`MESA` warnings in the terminal are normal under WSL (WebKitGTK falls back to software rendering).
If the window stays blank, start it with `WEBKIT_DISABLE_DMABUF_RENDERER=1 npm run tauri dev -w @hhereditas/desktop`.

### Windows (native) and macOS

Follow the Tauri prerequisites (<https://v2.tauri.app/start/prerequisites/>):
Windows needs the "Desktop development with C++" Build Tools and WebView2 (preinstalled on Windows 11);
macOS needs the Xcode Command Line Tools (`xcode-select --install`). Then install Rust and Node 22 and run `npm install`.

## 2. Everyday commands

```bash
npm test                                  # all unit tests (core, ui, viewer, desktop)
npm run typecheck                         # TypeScript across all workspaces

npm run dev -w @hhereditas/desktop        # the app in a browser at http://localhost:1420 (no Rust needed)
npm run tauri dev -w @hhereditas/desktop  # the real desktop app window (needs Rust + system libraries)
npm run tauri build -w @hhereditas/desktop  # installers for the CURRENT platform
```

### Component gallery

Every `*.gallery.tsx` file is a set of isolated component "stories":

- index: <http://localhost:1420/?gallery>
- one story: `http://localhost:1420/?gallery=CircularMap&story=pFA6a&theme=dark&platform=mac`

### Headless screenshots

```bash
node apps/desktop/scripts/shot.mjs --story Tokens/palette --theme dark --out /tmp/tokens.png
node apps/desktop/scripts/shot.mjs --app --platform mac --out /tmp/app.png
```

The script uses Playwright's Chromium (`npx playwright install chromium`). If the system NSS libraries
are missing and you cannot use sudo, user-local copies work too:

```bash
mkdir -p ~/.local/share/hh-browser-libs/debs && cd ~/.local/share/hh-browser-libs/debs
apt-get download libnss3 libnspr4 && for d in *.deb; do dpkg -x "$d" ../root; done
```

`shot.mjs` adds `~/.local/share/hh-browser-libs/root/usr/lib/x86_64-linux-gnu` to `LD_LIBRARY_PATH` automatically.

## 3. Test oracles (scientific correctness)

Results that matter in the lab — cut sites, overhangs, Tm values, translations, file parsing — are
checked against established tools. The Python environment is only needed to regenerate fixtures:

```bash
uv venv tools/oracle/.venv --python 3.12
uv pip install --python tools/oracle/.venv/bin/python biopython primer3-py pydna
tools/oracle/.venv/bin/python -I tools/oracle/<script>.py
```

The large E. coli genome used by performance tests is not committed:

```bash
curl -o packages/core/test/fixtures/large/ecoli_U00096.3.gb \
  "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=nuccore&rettype=gbwithparts&retmode=text&id=U00096.3"
```

## 4. Releases: installers and the in-app updater

Tauri builds native installers on the platform they target, so releases are built by GitHub Actions:
`.github/workflows/release.yml` builds Windows (`.msi`, `.exe`), macOS (`.dmg`, Apple Silicon and
Intel) and Linux (`.AppImage`, `.deb`) when a tag such as `v0.1.0` is pushed (or when run manually
from the Actions tab), signs them for the updater, and publishes them as a GitHub release together
with `latest.json`.

Installed copies of the app check
`https://github.com/pheretomus/HHereditas/releases/latest/download/latest.json` at startup
(`plugins.updater` in `tauri.conf.json`, `src/app/updater.ts`, `UpdateDialog.tsx`). When it names
a newer version they offer to download, install and relaunch, so every laptop with the app installed
picks a release up on its next launch. The repository must stay public for that URL to be reachable
without a token.

### One-time setup

1. The updater key pair was generated with `npx tauri signer generate -w ~/.tauri/hhereditas.key`.
   The public half is in `tauri.conf.json` (`plugins.updater.pubkey`); the private half,
   `~/.tauri/hhereditas.key`, is NOT in the repository. Back it up: a release signed with another key
   is rejected by installed apps, so losing it means they can never update again.
2. Add the private key to the repository secrets (the workflow fails without it):
   `gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.tauri/hhereditas.key` and, for a key without a
   password, `gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --body ""`.

### Shipping a version

1. Bump the version in `apps/desktop/src-tauri/tauri.conf.json`, `apps/desktop/src-tauri/Cargo.toml`
   and `VERSION` in `apps/desktop/src/app/App.tsx` (the updater compares `tauri.conf.json`'s).
2. Commit, then tag and push: `git tag v0.2.0 && git push origin main v0.2.0`.
3. Wait for the Release workflow (about 15 minutes). The release appears under Releases with the
   installers, their `.sig` files and `latest.json`. Nothing else is needed: apps already installed
   see it on their next launch.

Unsigned builds work but show a warning on first launch (macOS Gatekeeper: right-click → Open;
Windows SmartScreen: More info → Run anyway). Code signing needs an Apple Developer ID and a Windows
code-signing certificate; add them as repository secrets when the project is ready for wide release.

## 5. Coordinate conventions

Read the header of `packages/core/src/types.ts` before touching sequence code: positions are 0-based,
ranges half-open, and ranges that cross the origin of a circular molecule have `end > length`.
User-visible positions are always 1-based.
