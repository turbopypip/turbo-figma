import { LIVE_LIMITS } from './network-live.js';
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
  z.object({ ...common, action: z.literal('heartbeat') }).strict(),
  z.object({ ...common, action: z.literal('delta'), sequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1),
    data: z.string().min(4).max(4 * Math.ceil(LIVE_LIMITS.recordBytes / 3)) }).strict(),
]);
const liveRecord = z.object({ version: z.literal(1), kind: z.enum(['ws-received', 'ws-sent']), session: z.string().min(1).max(256),
  requestId: z.string().min(1).max(256), opcode: z.literal(2), eventSequence: z.number().int().nonnegative(),
  payload: z.string().min(1).max(LIVE_LIMITS.recordBytes) }).strict();
type Writer = Awaited<ReturnType<NetworkStore['begin']>>;

/** One authenticated socket owns a transfer. No incoming work queue. */
export class NetworkTransfer {
  private writer?: Writer;
  private inspector?: InitialSnapshotInspector;
  private snapshot?: z.infer<typeof snapshotSchema>;
  private observation?: AbortController;
  private cursor?: { eventSequence: number; socket?: string };
  private revision = 0;
  private liveBytes = 0;
  private next = 0;
  private closed = false;
  private closing?: Promise<void>;
  private controller = new AbortController();
  private work?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private store: Pick<NetworkStore, 'begin' | 'observe' | 'renewObservation' | 'applyLive'>, private fileKey: string | undefined,
    private reply: (message: unknown) => void, private disconnect: () => void, private timeout = 30000) {}
  get busy() { return (!!this.snapshot && !this.observation) || !!this.work; }
  receive(value: unknown, blocked: boolean) {
    if (this.closed) return;
    const parsed = command.safeParse(value);
    if (!parsed.success) {
      this.fail('Invalid capture command: ' + parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.code}`).join('; '));
      return;
    }
    if (this.work) { this.fail('Capture queue overflow: previous command is still pending'); return; }
    const msg = parsed.data;
    // Observation traffic must continue during UI work. applyLive still checks
    // the reader/index lease and rejects unsupported or concurrent mutations.
    if ((blocked && !['heartbeat', 'delta'].includes(msg.action)) || !this.fileKey || msg.snapshot.fileKey !== this.fileKey) { this.fail('Capture busy or file mismatch'); return; }
    if (msg.action === 'begin' ? !!this.snapshot : !this.snapshot ||
      JSON.stringify(msg.snapshot) !== JSON.stringify(this.snapshot)) { this.fail('Capture session mismatch'); return; }
    if (msg.action === 'begin') this.snapshot = msg.snapshot;
    if (this.observation && !['heartbeat', 'delta'].includes(msg.action)) { this.fail('Capture already committed'); return; }
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.fail('Capture observation timeout: reload Figma and capture again'), this.observation ? 15000 : this.timeout);
    this.work = (async () => {
      try {
        await Promise.resolve();
        if (msg.action === 'begin') {
          this.inspector = new InitialSnapshotInspector();
          this.writer = await this.store.begin(msg.snapshot, undefined, true);
        }
        else if (msg.action === 'part') {
          if (msg.sequence !== this.next) throw new Error('Capture sequence mismatch');
          const bytes = Buffer.from(msg.data, 'base64');
          if (!bytes.length || bytes.length > TRANSFER_PART_BYTES || bytes.toString('base64') !== msg.data) throw new Error('Invalid capture part');
          this.inspector?.push(bytes);
          await this.writer!.append(msg.sequence, bytes);
          this.next++;
        } else if (msg.action === 'delta') {
          if (!this.observation || !this.cursor || msg.sequence !== this.revision) throw new Error('STALE: live sequence mismatch');
          const bytes = Buffer.from(msg.data, 'base64');
          if (!bytes.length || bytes.length > LIVE_LIMITS.recordBytes || bytes.toString('base64') !== msg.data) throw new Error('STALE: invalid live record size or encoding');
          const record = liveRecord.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
          if (record.eventSequence !== this.cursor.eventSequence + this.revision || JSON.stringify([record.session, record.requestId]) !== this.cursor.socket) throw new Error('STALE: live event gap or foreign stream');
          if (this.inspector!.isServiceMessage(record.payload, record.kind)) this.store.renewObservation(this.observation);
          else {
            if (record.kind === 'ws-sent') throw new Error('Unsupported outgoing document message');
            // Service traffic is validated and discarded, not retained in the
            // document index. Only mutations consume the cumulative live budget.
            if ((this.liveBytes += bytes.length) > LIVE_LIMITS.bytes) throw new Error('STALE: live document byte budget exceeded');
            await this.store.applyLive(msg.snapshot, this.observation, record.payload);
          }
          this.revision++;
        } else if (msg.action === 'heartbeat') {
          if (!this.observation) throw new Error('Observation is not ready');
          this.store.renewObservation(this.observation);
        } else {
          if (msg.evidence.receivedParts !== this.next) throw new Error('Capture part count mismatch');
          await this.writer!.commit(this.inspector!.evidence(this.next), this.controller.signal);
          if (!this.closed) { this.cursor = this.inspector!.liveCursor; this.observation = this.store.observe(msg.snapshot); }
        }
        if (this.closed) return;
        this.reply({ type: 'capture-result', id: msg.id, snapshot: msg.snapshot, action: msg.action,
          nextSequence: this.next, revision: this.revision, ...(this.inspector ? { initial: this.inspector.progress } : {}), status: this.observation ? 'ready' : 'capturing' });
        if (msg.action === 'finish') {
          clearTimeout(this.timer);
          this.writer = undefined;
          this.timer = setTimeout(() => this.fail('STALE: observation heartbeat lost; reload and capture again'), 15000);
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
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.observation?.abort(new Error('STALE: observation ended; reload Figma and capture again'));
    this.controller.abort();
    clearTimeout(this.timer);
    this.closing = (async () => {
      await this.work;
      if (this.writer?.state.status === 'capturing') await this.writer.abort('Capture connection closed').catch(() => {});
      this.writer = undefined; this.snapshot = undefined; this.inspector = undefined;
    })();
    return this.closing;
  }
}
