import { InitialSnapshotInspector } from './network-initial.js';
import { z } from 'zod';
import type { NetworkStore } from './network-store.js';

export const TRANSFER_PART_BYTES = 256 * 1024;
const snapshotSchema = z.object({ fileKey: z.string().regex(/^[A-Za-z0-9]{1,256}$/),
  sessionId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict();
const evidenceSchema = z.object({ schemaReceived: z.literal(true), joinStarted: z.literal(true), joinEnded: z.literal(true),
  receivedParts: z.number().int().positive().max(10000), droppedParts: z.literal(0), sequenceComplete: z.literal(true) }).strict();
const common = { type: z.literal('capture'), id: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/), snapshot: snapshotSchema };
const command = z.discriminatedUnion('action', [
  z.object({ ...common, action: z.literal('begin'), format: z.literal('ndjson-v1').optional() }).strict(),
  z.object({ ...common, action: z.literal('part'), sequence: z.number().int().min(0).max(9999),
    data: z.string().min(4).max(4 * Math.ceil(TRANSFER_PART_BYTES / 3)) }).strict(),
  z.object({ ...common, action: z.literal('finish'), evidence: evidenceSchema }).strict(),
]);
type Writer = Awaited<ReturnType<NetworkStore['begin']>>;

/** One authenticated socket owns a transfer. No incoming work queue. */
export class NetworkTransfer {
  private writer?: Writer;
  private inspector?: InitialSnapshotInspector;
  private snapshot?: z.infer<typeof snapshotSchema>;
  private next = 0;
  private closed = false;
  private controller = new AbortController();
  private work?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private store: Pick<NetworkStore, 'begin'>, private fileKey: string | undefined,
    private reply: (message: unknown) => void, private disconnect: () => void, private timeout = 30000) {}
  get busy() { return !!this.snapshot || !!this.work; }
  receive(value: unknown, blocked: boolean) {
    if (this.closed) return;
    const parsed = command.safeParse(value);
    if (!parsed.success || this.work) { this.fail('Invalid capture command or queue overflow'); return; }
    const msg = parsed.data;
    if (blocked || !this.fileKey || msg.snapshot.fileKey !== this.fileKey) { this.fail('Capture busy or file mismatch'); return; }
    if (msg.action === 'begin' ? !!this.snapshot : !this.snapshot ||
      JSON.stringify(msg.snapshot) !== JSON.stringify(this.snapshot)) { this.fail('Capture session mismatch'); return; }
    if (msg.action === 'begin') this.snapshot = msg.snapshot;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.fail('Initial capture timeout: reload Figma and capture again'), this.timeout);
    this.work = (async () => {
      try {
        if (msg.action === 'begin') {
          this.inspector = new InitialSnapshotInspector();
          this.writer = await this.store.begin(msg.snapshot);
        }
        else if (msg.action === 'part') {
          if (msg.sequence !== this.next) throw new Error('Capture sequence mismatch');
          const bytes = Buffer.from(msg.data, 'base64');
          if (!bytes.length || bytes.length > TRANSFER_PART_BYTES || bytes.toString('base64') !== msg.data) throw new Error('Invalid capture part');
          this.inspector?.push(bytes);
          await this.writer!.append(msg.sequence, bytes);
          this.next++;
        } else {
          if (msg.evidence.receivedParts !== this.next) throw new Error('Capture part count mismatch');
          await this.writer!.commit(this.inspector!.evidence(this.next), this.controller.signal);
        }
        if (this.closed) return;
        this.reply({ type: 'capture-result', id: msg.id, snapshot: msg.snapshot, action: msg.action,
          nextSequence: this.next, ...(this.inspector ? { initial: this.inspector.progress } : {}), status: msg.action === 'finish' ? 'ready' : 'capturing' });
        if (msg.action === 'finish') {
          clearTimeout(this.timer);
          this.snapshot = undefined; this.writer = undefined; this.inspector = undefined; this.next = 0;
        }
      } catch (error) { this.fail(error instanceof Error ? error.message : 'Capture failed'); }
      finally {
        if (this.closed && this.writer?.state.status === 'capturing') await this.writer.abort('Capture connection closed').catch(() => {});
        this.work = undefined;
      }
    })();
  }
  private fail(reason: string) {
    if (this.closed) return;
    this.reply({ type: 'capture-error', error: reason.slice(0, 500) });
    void this.close();
    this.disconnect();
  }
  async close() {
    this.closed = true;
    this.controller.abort();
    clearTimeout(this.timer);
    await this.work;
    if (this.writer?.state.status === 'capturing') await this.writer.abort('Capture connection closed').catch(() => {});
    this.writer = undefined; this.snapshot = undefined; this.inspector = undefined;
  }
}
