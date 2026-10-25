/** Contract for the managed capture path. Manual probe JSON is not a managed session. */
export type SnapshotIdentity = Readonly<{ fileKey: string; sessionId: string; generation: number }>;
export type SelectionRequest = Readonly<{
  fileKey: string; nodeId: string; depth: number; maxNodes: number; maxBytes: number; includeHidden: boolean;
}>;
export type Continuation = Readonly<{
  version: 1; snapshot: SnapshotIdentity; selection: SelectionRequest; nextOffset: number;
}>;
export type ReadErrorCode = 'INVALID_REQUEST' | 'FILE_MISMATCH' | 'CAPTURING' | 'STALE' | 'CAPTURE_ERROR'
  | 'INVALID_CONTINUATION' | 'NODE_NOT_FOUND' | 'LIMIT_EXCEEDED' | 'CANCELLED';
export type SelectionFailure = Readonly<{ ok: false; code: ReadErrorCode; message: string }>;
export type SelectionResult<T> = SelectionFailure | Readonly<{
  ok: true; snapshot: SnapshotIdentity; nodeId: string; nodes: readonly T[];
  completeness: 'complete' | 'partial'; limitations: readonly string[]; continuation: Continuation | null;
}>;
export type SnapshotState =
  | Readonly<{ status: 'capturing'; snapshot: SnapshotIdentity }>
  | Readonly<{ status: 'ready'; snapshot: SnapshotIdentity }>
  | Readonly<{ status: 'stale'; snapshot: SnapshotIdentity; reason: string }>
  | Readonly<{ status: 'error'; snapshot: SnapshotIdentity; reason: string }>;
/** Evidence must be established by the collector/storage, never supplied by an MCP caller. */
export type InitialSnapshotEvidence = Readonly<{
  schemaReceived: boolean; joinStarted: boolean; joinEnded: boolean;
  receivedParts: number; persistedParts: number; droppedParts: number;
  sequenceComplete: boolean; metadataCommitted: boolean;
}>;
export type SessionEvent =
  | Readonly<{ type: 'complete'; snapshot: SnapshotIdentity; evidence: InitialSnapshotEvidence }>
  | Readonly<{ type: 'invalidate'; snapshot: SnapshotIdentity; reason: string }>
  | Readonly<{ type: 'fail'; snapshot: SnapshotIdentity; reason: string }>;

function validIdentity(id: SnapshotIdentity): boolean {
  return /^[A-Za-z0-9]+$/.test(id.fileKey) && /^[A-Za-z0-9_-]{1,128}$/.test(id.sessionId)
    && Number.isSafeInteger(id.generation) && id.generation >= 1;
}
function sameIdentity(a: SnapshotIdentity, b: SnapshotIdentity): boolean {
  return a.fileKey === b.fileKey && a.sessionId === b.sessionId && a.generation === b.generation;
}
export function createCapture(snapshot: SnapshotIdentity): SnapshotState {
  if (!validIdentity(snapshot)) throw new Error('Invalid snapshot identity');
  return Object.freeze({ status: 'capturing', snapshot: Object.freeze({ ...snapshot }) });
}

/** Terminal states require a fresh capture identity; they can never become ready again. */
export function transitionSession(state: SnapshotState, event: SessionEvent): SnapshotState {
  if (!sameIdentity(state.snapshot, event.snapshot)) throw new Error('Event belongs to another snapshot');
  if (state.status === 'stale' || state.status === 'error') throw new Error('Terminal session state');
  if (event.type === 'complete') {
    if (state.status !== 'capturing') throw new Error('Only capturing can become ready');
    const e = event.evidence;
    if (!e.schemaReceived || !e.joinStarted || !e.joinEnded || !e.sequenceComplete || !e.metadataCommitted
      || !Number.isSafeInteger(e.receivedParts) || e.receivedParts < 1
      || e.persistedParts !== e.receivedParts || e.droppedParts !== 0) {
      throw new Error('Incomplete initial snapshot');
    }
    return Object.freeze({ status: 'ready', snapshot: state.snapshot });
  }
  if (!event.reason.trim()) throw new Error('A failure/invalidation reason is required');
  return Object.freeze({ status: event.type === 'fail' ? 'error' : 'stale', snapshot: state.snapshot, reason: event.reason });
}

function validSelection(q: SelectionRequest): boolean {
  return /^[A-Za-z0-9]+$/.test(q.fileKey) && /^\d+:\d+$/.test(q.nodeId)
    && Number.isInteger(q.depth) && q.depth >= 0 && q.depth <= 50
    && Number.isInteger(q.maxNodes) && q.maxNodes >= 1 && q.maxNodes <= 500
    && Number.isInteger(q.maxBytes) && q.maxBytes >= 1 && q.maxBytes <= 150000
    && typeof q.includeHidden === 'boolean';
}
function sameSelection(a: SelectionRequest, b: SelectionRequest): boolean {
  return a.fileKey === b.fileKey && a.nodeId === b.nodeId && a.depth === b.depth
    && a.maxNodes === b.maxNodes && a.maxBytes === b.maxBytes && a.includeHidden === b.includeHidden;
}
const failure = (code: ReadErrorCode, message: string): SelectionFailure => ({ ok: false, code, message });

/** Gate the start and completion of reads, so an invalidated in-flight read cannot escape. */
export function checkSelectionRead(state: SnapshotState, query: SelectionRequest, continuation?: Continuation, expectedSnapshot?: SnapshotIdentity):
  SelectionFailure | Readonly<{ ok: true; snapshot: SnapshotIdentity; offset: number }> {
  if (!validSelection(query)) return failure('INVALID_REQUEST', 'Invalid selection or traversal limits');
  if (query.fileKey !== state.snapshot.fileKey) return failure('FILE_MISMATCH', 'Selection file does not match capture');
  if (expectedSnapshot && !sameIdentity(expectedSnapshot, state.snapshot)) return failure('STALE', 'Snapshot changed during read');
  if (state.status === 'capturing') return failure('CAPTURING', 'Initial snapshot has not been committed');
  if (state.status === 'stale') return failure('STALE', state.reason);
  if (state.status === 'error') return failure('CAPTURE_ERROR', state.reason);
  if (continuation && (continuation.version !== 1 || !sameIdentity(continuation.snapshot, state.snapshot)
    || !sameSelection(continuation.selection, query) || !Number.isSafeInteger(continuation.nextOffset) || continuation.nextOffset < 1)) {
    return failure('INVALID_CONTINUATION', 'Continuation does not match snapshot, selection or query parameters');
  }
  return { ok: true, snapshot: state.snapshot, offset: continuation?.nextOffset ?? 0 };
}
