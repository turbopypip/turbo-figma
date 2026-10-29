# turbo-figma

**English** | [Русский](README.ru.md)

A browser extension and local Rust MCP server that lets an AI agent work with Figma designs. It connects to an open tab and provides design context, screenshots, and assets.

## Features

- Read layer trees, dimensions, Auto Layout, styles, text, and components from a Figma node URL.
- Retrieve the current selection and track design changes during active capture.
- Work with Figma variables and map values to your UI kit's CSS variables.
- Capture nodes as PNG screenshots and export PNG/SVG assets to a chosen directory.
- Check the connection and manage the cache from the extension popup.

The Kilo CLI integration exposes `get_connection_status`, `get_selection`, `get_design_map`, `get_design_context`, `get_screenshot`, and `export_assets`.

Kilo exposes tools with the `turbo_figma_` prefix, for example `turbo_figma_get_design_context`. When upgrading an existing configuration, rename the MCP entry from `turbo-figma` to `turbo_figma` and restart MCP in Kilo.

## Installation

### Release archives

Download the archive for your system from [GitHub Releases](https://github.com/turbopypip/turbo-figma/releases). Archives become available after a maintainer publishes a release; if none is published yet, use the source build below.

| System | Archive |
| --- | --- |
| Windows x64 | `turbo-figma-vX.Y.Z-windows-x64.zip` |
| Linux x64 (Ubuntu 22.04 or compatible) | `turbo-figma-vX.Y.Z-linux-x64.tar.gz` |
| macOS Apple Silicon (arm64) | `turbo-figma-vX.Y.Z-macos-arm64.tar.gz` |

Each archive includes the compiled Rust server, browser extension (RU/EN), setup scripts, and documentation. Intel Macs and other architectures currently require a source build.

1. Extract the archive to a permanent directory.
2. Install Node.js 20.12+ for the setup script. Rust, a compiler, and `npm ci` are not needed.
3. From the extracted directory, configure an absolute asset path:

   ```sh
   node scripts/setup.mjs --assets /absolute/path/to/project/public/figma
   ```

   On Windows, for example:

   ```powershell
   node scripts/setup.mjs --assets 'C:\Projects\site\public\figma'
   ```

4. Load the `extension/` directory as described below, then follow **Usage**.

### Build from source

Clone the repository:

```sh
git clone https://github.com/turbopypip/turbo-figma.git
cd turbo-figma
```

### Windows 10/11 x64

Run this in PowerShell from the project directory:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Assets 'C:\Projects\site\public\figma'
```

Set `-Assets` to the directory for exported images. The script installs missing dependencies through winget, builds the server, and prepares the configuration. Add `-SkipDependencies` if Node.js, Rust, and MSVC are already installed.

### macOS / Linux

Requires Node.js 20.12+, Rust/Cargo, and a C/C++ compiler. On macOS, install Xcode Command Line Tools with `xcode-select --install`.

```sh
npm ci
npm run build
npm run setup -- --assets /absolute/path/to/project/public/figma
```

Set `--assets` to an absolute image directory path. The compiled server is at `target/release/turbo-figma` (`turbo-figma.exe` on Windows).

### Browser extension

Requires Chrome or a compatible Chromium browser, version 125+.

The extension uses Russian when the browser UI language is Russian, and English otherwise. Buttons, connection and capture statuses, and badge tooltips are localized. Reload the extension in `chrome://extensions` after updating.

Use the same `extension/` folder from the extracted release for every browser:

| Browser | Open the extensions page |
| --- | --- |
| Google Chrome / Chromium | `chrome://extensions` |
| Microsoft Edge | `edge://extensions` |
| Brave | `brave://extensions` |
| Opera / Opera GX | `opera://extensions` |
| Vivaldi | Menu → Tools → Extensions |

1. Open the page for your browser and enable **Developer mode**.
2. Click **Load unpacked** (or **Load unpacked extension**) and select `extension/`, the folder containing `manifest.json`. Do not select the archive or its top-level folder.
3. Pin **turbo-figma** from the browser's Extensions menu, open a Figma design, and follow **Usage** below.
4. Keep the extracted folder in place. After an update, click **Reload** on the extension's card on the same extensions page, then reconnect to Figma.

Installation references: [Chrome](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world), [Edge](https://learn.microsoft.com/en-us/microsoft-edge/extensions/getting-started/extension-sideloading), [Opera](https://help.opera.com/en/extensions/testing/), [Vivaldi](https://help.vivaldi.com/desktop/appearance-customization/extensions/). These are installation instructions, not a claim that every browser has been tested with Figma. Capture requires Chromium 125+ and the `debugger` API. This package does not support Firefox or Safari.

## Usage

1. Merge the generated `.local/kilo.json` entry into your Kilo CLI MCP configuration. See [examples/kilo.json](examples/kilo.json).
2. Start the MCP server through Kilo and open your Figma design in the browser.
3. Click **turbo-figma**, enter the port and secret from `.local/pairing.txt`, and click **Connect**. The secret is remembered for subsequent connections.
4. The extension automatically reloads the connected Figma tab and loads the design. Wait until it is ready.
   **Disconnect** stops the connection and capture. The cache size updates automatically; **Clear cache** removes local snapshots.
5. Give the agent a Figma node URL and describe your task.

For example: “Read this section's design, take a screenshot, and export the images needed to implement it.”

Screenshots or asset exports can run alongside `get_design_map` and `get_design_context`: short snapshot reads wait their turn, while browser operations run independently. Specify `url` or node IDs explicitly because exports change the selection. `get_connection_status` is also available during operations. `get_selection` may see the changed selection or ask you to retry.

Only one `get_screenshot` or one `export_assets` batch can run at a time; a second request receives `busy`. Assets within a batch are exported sequentially. Wait for requests to finish before clearing the cache, starting a new capture, or reconnecting. Screenshots and network snapshots are not guaranteed to represent the same instant; revision changes still require a fresh read.

### Reading designs with an agent

1. `get_design_map({url})` returns a compact branch map: IDs, parents, names, types, geometry, and `hasChildren`. The default depth is 2. Then use `get_screenshot({url})` for a visual reference.
2. `get_design_context({url, nodeIds, observation, revision})` reads selected sections in batches of up to 20 IDs. Keep `url` pointing to the original root; use `nodeIds` from the map unchanged, including paths inside instances. Overlapping sections are deduplicated. `depth` is relative to each selected section.
3. For targeted details, use `get_design_context({url, nodeIds, depth: 0, fields: ["text"], observation, revision})`. Field groups are `layout`, `style`, `text`, and `component`; all are returned by default. When reading a container directly, `pendingDepth` reports unread descendants even if the container itself was fully returned.

Take `observation` from the map response and `revision` from `freshness.revision`. If the snapshot or revision changes, the server returns STALE: refresh the map. Screenshots are taken separately from the live tab and are not an atomic part of the network snapshot.

All reads are bounded by `maxBytes` (24,000 bytes by default) and `maxNodes` (200). Request subsequent pages with unchanged arguments and `traversal.continuation`. Also check `pendingDepth`, `missingNodeIds`, `propertiesOmitted`, and unresolved diagnostics: reaching the end of pagination does not mean all data is complete. The `nodeIds` search is limited by the original branch, visibility, and a scan depth of 50; missing IDs are listed explicitly. For a deeper map, repeat `get_design_map` with a higher `depth` (up to 12).

Compact responses contain combined CSS in `layout.css`. If `layout` is excluded, combined CSS is available in `style.css`. Duplicate `properties`, `cssText`, the CSS copy in `style` when `layout` is present, and repeated per-node explanations are omitted. `resolvedValues` contains original values only for CSS properties replaced with variables. Shared rules appear in `semantics`; individual error reasons, original styles, text, overrides, and hug/fill rules are preserved. A group excluded through `fields` does not imply that its properties are absent in Figma.

After updating, restart MCP in your client so it reloads the tool list and instructions.

To use your UI kit's CSS variables, add `variablesFile` with an absolute CSS file path to `.local/config.json` and restart MCP. The file must contain flat `:root` blocks with custom properties.

Screenshots and exports run in the background through Figma's native Export: they do not activate the tab or window or use the clipboard. During network capture, the extension keeps Figma active through the debugger so you can switch tabs. Export preserves this mode; stopping capture removes it along with the debugger. When exporting without capture, this mode is enabled only for the operation. After capture disconnects, click **Connect** again. The connection secret is stored locally; do not share it with the agent.

### Extension statuses

The toolbar badge shows the connection state. Click it to see a detailed message.

| Badge | Meaning | Action |
| --- | --- | --- |
| **ON**, green | The extension is connected to MCP. | Check capture readiness in the popup, then give the agent a task. |
| **RUN**, blue | An agent request is running. | You can work in another window; the request does not change focus. |
| **…**, yellow | Connecting or waiting for reconnection. | Wait. If it persists, check that MCP is running in Kilo and the port matches. |
| **OFF**, gray | Disconnected. | Open the desired Figma tab, click the extension icon, and click **Connect**. |
| **!**, red — stale snapshot | Capture was interrupted; previous data is no longer current. | Click **Connect** to reload the tab and start a new capture. |
| **!**, red — connection error | The connection was rejected or could not be restored. | Read the popup message. Check the port and secret, disconnect any other connection to this MCP server, and retry **Connect**. |

**ON does not mean the design has been captured.** The popup's **Network capture** section has a separate status:

| Message | Action |
| --- | --- |
| Capture disabled or stopped | Open the desired Figma tab and click **Connect**. |
| Connecting capture, recording, or saving a snapshot | Wait for the design to finish loading. |
| Snapshot saved; observation enabled | The agent can read the design. |
| Checking network update… | Wait for changes to be applied. |
| Stale snapshot, incomplete capture, or timeout | Click **Connect** again. |
| Capture unavailable or debugging could not be enabled | Check the browser version and the extension's `debugger` permission. Follow the popup message. |

### Recovering from a disconnect

Reconnecting restores the bridge but does not make the previous snapshot current. After reconnecting or restarting MCP or the service worker, click **Connect** and wait until ready. The extension prompts you to do this. Clicking **Connect** reloads the tab and starts capture; automatic reconnection alone does not reload the tab. Start reading again: continuations from the previous observation are invalid.

`get_connection_status` separately returns `readReady` (ready to start reading), `snapshotState` (`capture_required`, `capturing`, `ready`), and `nextAction` (`connect`, `wait`, `reload_and_capture`, `read`). Readiness refers to the connected file's snapshot and does not guarantee a selection or export availability. Status reflects the moment it was checked.

Vector descendants and individual text characters are returned compactly in detailed context: ID, geometry, CSS, and original text, marked with `detailsOmitted`. Retrieve full properties with `nodeIds: [id]`, `depth: 0`. Screenshots and exports expand the target node's ancestors from top to bottom using the network snapshot; the required page must be open in Figma.

## Publishing releases

The existing [Actions workflow](.github/workflows/test.yml) checks, tests, and packages the project on Windows x64, Linux x64, and macOS arm64. Ordinary pushes and pull requests produce downloadable Actions artifacts. A pushed `vX.Y.Z` tag additionally publishes a **GitHub Release** with three archives and `SHA256SUMS`, only after all three jobs pass.

1. Set the same version in `package.json`, `package-lock.json` (including its root package), `Cargo.toml`, the `turbo-figma` entry in `Cargo.lock`, `extension/manifest.json`, and `resources/tools.json`. Use patch for fixes, minor for compatible features, major for incompatible changes.
2. Write bilingual release notes in `releases/X.Y.Z.md`, check the extension’s connection to Figma, run `npm run check` and `npm test`, commit the changes, and push the release tag matching that version:

   ```sh
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

3. Wait for Actions: it uploads the three archives and checksums to a draft, then publishes the release automatically. Notes come from `releases/X.Y.Z.md` and should include compatibility and upgrade steps. Version or tag mismatches fail the checks.

`npm run release:pack` packages the current platform locally into `dist/` after building. Packaging uses an explicit file list and excludes `.local/`, secrets, caches, and development dependencies. Tests extract an archive, execute the packaged binary, and run setup without installing dependencies.

To update, stop MCP, replace the server and extension together, preserve `.local/`, reload the extension in `chrome://extensions`, restart MCP, and capture again. If you move to a new directory, copy `.local/` there, rerun setup with the same asset path, and update the Kilo configuration with the generated paths.

## License

[MIT](LICENSE) © 2026 Denis Kochkin.
