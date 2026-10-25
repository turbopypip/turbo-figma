import { z } from 'zod';
import { inflateFrame } from './network.js';
import { BoundedWireDecoder, WIRE_LIMITS } from './network-wire.js';
const MAX_RECORD = 16 * 1024 * 1024;
const recordSchema = z.object({ version: z.literal(1), kind: z.literal('ws-received'),
  session: z.string().min(1).max(256), requestId: z.string().min(1).max(256), opcode: z.literal(2),
  eventSequence: z.number().int().nonnegative(), payload: z.string().max(8 * 1024 * 1024) }).strict();
/** Inspect one bounded NDJSON record at a time. No document index or retained node array. */
export class InitialSnapshotInspector {
  private pending = Buffer.alloc(0);
  private codec?: BoundedWireDecoder;
  private socket?: string;
  private sequence = 0;
  private started = false;
  private ended = false;
  private nodes = 0;
  get progress() { return { schemaReceived: !!this.codec, joinStarted: this.started, joinEnded: this.ended,
    initialComplete: this.ended && !this.pending.length }; }
  push(bytes: Uint8Array) {
    if (this.pending.length + bytes.length > MAX_RECORD) throw new Error('Initial record too large');
    this.pending = Buffer.concat([this.pending, bytes]);
    let newline;
    while ((newline = this.pending.indexOf(10)) !== -1) {
      const line = this.pending.subarray(0, newline);
      const record = recordSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)));
      this.pending = this.pending.subarray(newline + 1);
      if (this.ended) throw new Error('Messages after JOIN_END; recapture a clean initial load');
      if (record.eventSequence !== this.sequence++) throw new Error('Missing or repeated captured event');
      const socket = JSON.stringify([record.session, record.requestId]);
      if (this.socket && socket !== this.socket) throw new Error('Multiple multiplayer streams; reload and capture again');
      this.socket = socket;
      const binary = Buffer.from(record.payload, 'base64');
      if (!binary.length || binary.toString('base64') !== record.payload) throw new Error('Invalid binary multiplayer payload');
      if (binary.subarray(0, 8).toString() === 'fig-wire') {
        if (this.codec || binary.length < 12 || binary.readUInt32LE(8) !== 1) throw new Error('Unsupported or repeated wire schema');
        this.codec = new BoundedWireDecoder(inflateFrame(binary.subarray(12), WIRE_LIMITS.schemaBytes), new Set(['phase']));
      } else {
        if (!this.codec) throw new Error('Initial schema missing: reload Figma and capture again');
        const before = this.nodes;
        const decoded = inflateFrame(binary, WIRE_LIMITS.frameBytes);
        const message = this.codec.decode(decoded, node => {
          if (!this.started || this.ended || node.phase !== 'CREATED') throw new Error('Invalid initial node batch');
          if (++this.nodes > 200000) throw new Error('Initial node count limit exceeded');
        });
        if (message.type !== 'NODE_CHANGES' && this.nodes !== before) throw new Error('Nodes outside initial node batch');
        if (message.type === 'JOIN_START') {
          if (this.started) throw new Error('Repeated JOIN_START');
          this.started = true;
        } else if (message.type === 'JOIN_END') {
          if (!this.started || !this.nodes) throw new Error('Incomplete initial snapshot before JOIN_END');
          this.ended = true;
        } else if (message.type === 'NODE_CHANGES') {
          if (!this.started || this.nodes === before) throw new Error('Missing initial node batch');
        } else if (this.nodes !== before || !message.type) throw new Error('Invalid initial message type');
      }
    }
    // Do not retain the backing allocation of consumed records.
    this.pending = Buffer.from(this.pending);
  }
  evidence(receivedParts: number) {
    if (!this.progress.initialComplete) throw new Error('Initial load incomplete: schema, JOIN_START or JOIN_END missing; reload and capture again');
    return { schemaReceived: true, joinStarted: true, joinEnded: true, receivedParts, droppedParts: 0, sequenceComplete: true };
  }
}
