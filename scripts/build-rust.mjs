import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
const local=path.join(root,'.local','cargo','bin',process.platform==='win32'?'cargo.exe':'cargo');
const managed=existsSync(local);
const result=spawnSync(managed?local:'cargo',['build','--locked','--release','--manifest-path',path.join(root,'rust/helper/Cargo.toml')],{
 stdio:'inherit',cwd:root,env:managed?{...process.env,CARGO_HOME:path.join(root,'.local/cargo'),RUSTUP_HOME:path.join(root,'.local/rustup')}:process.env,
});
if(result.error)console.error(`Rust build failed: ${result.error.message}. Install the documented Rust toolchain or use FIGMA_NETWORK_BACKEND=node.`);
process.exit(result.status??1);
