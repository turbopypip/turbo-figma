import { parentPort } from 'node:worker_threads';
import { RUST_PACKET_BYTES } from './network-rust.js';

/** One bounded synchronous request from projection worker; main event loop stays asynchronous. */
export class RustStorage {
  private state: Int32Array;
  private bytes: Uint8Array;
  stats: any;
  // Only command identities survive between projections. Values are bounded,
  // temporary transfer data; the retained selection cache remains in Rust.
  private known = new Map<string, Record<string, unknown>>();
  private knownBytes = 0;
  private page = new Map<string, string>();
  private pageBytes = 0;
  beginQuery() {
    this.page.clear(); this.pageBytes = 0;
    const keys = [...this.known.keys()], requests = [...this.known.values()];
    if (requests.length) {
      const values: [number, string][] = this.exchange({op:'batch',requests});
      for (const [index,value] of values) this.rememberText(keys[index],value);
    }
  }
  endQuery() { this.page.clear(); this.pageBytes = 0; }
  private remember(key: string, value: unknown) {
    this.rememberText(key,JSON.stringify(value));
  }
  private rememberText(key: string, text: string) {
    const charge = 2 * (key.length + text.length) + 128;
    if (this.pageBytes + charge <= 4 * 1024 * 1024) { this.page.set(key,text); this.pageBytes += charge; }
  }
  constructor(private shared: SharedArrayBuffer, stats: any) {
    this.state = new Int32Array(shared, 0, 2); this.bytes = new Uint8Array(shared, 8); this.stats = stats;
  }
  call(command: Record<string, unknown>): any {
    const read = ['node','slot','children','asset'].includes(String(command.op));
    if (!read) { this.page.clear(); this.pageBytes = 0; this.known.clear(); this.knownBytes = 0; }
    const key = JSON.stringify(command), cached = read ? this.page.get(key) : undefined;
    if (cached !== undefined) return JSON.parse(cached);
    const result = this.exchange(command);
    if (read) {
      if (!this.known.has(key) && this.known.size < 512 && this.knownBytes + Buffer.byteLength(key) <= 65536) {
        this.known.set(key,command); this.knownBytes += Buffer.byteLength(key);
      }
      this.remember(key,result);
    }
    return result;
  }
  private exchange(command: Record<string, unknown>): any {
    Atomics.store(this.state, 0, 0);
    parentPort!.postMessage({ rustRequest: command });
    if (Atomics.wait(this.state, 0, 0, 15000) === 'timed-out') throw new Error('Rust projection request timed out');
    const length = Atomics.load(this.state, 1);
    if (length < 0 || length > RUST_PACKET_BYTES) throw new Error('Invalid Rust response size');
    const response = JSON.parse(Buffer.from(this.bytes.subarray(0, length)).toString('utf8'));
    if (response.error) throw new Error(response.error);
    this.stats = response.stats;
    return response.result;
  }
}
