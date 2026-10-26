// Convenience launcher only. Generated MCP configs invoke the Rust binary directly.
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
const binary=process.env.FIGMA_RUST_BINARY ?? path.join(root,`rust/helper/target/release/figma-rust-helper${process.platform==='win32'?'.exe':''}`);
if(!existsSync(binary))throw Error('Rust binary not found. Run npm run build first.');
const config=process.env.FIGMA_KILO_CONFIG ?? path.join(root,'.local/config.json');
const child=spawn(binary,['--server',config,root],{stdio:'inherit',windowsHide:true});
const kill=()=>child.kill('SIGKILL');
process.once('exit',kill);
process.once('SIGINT',()=>child.kill('SIGINT'));
process.once('SIGTERM',()=>child.kill('SIGTERM'));
child.once('error',error=>{console.error(error.message);process.exitCode=1;});
child.once('close',(code)=>{process.off('exit',kill);process.exitCode=code??1;});
