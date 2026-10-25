// Benchmark-only compatibility adapter. The production managed-cache decoder is TODO 08.
// Run inside the measured MCP process; retain at most one bounded NDJSON record.
import { open } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
export async function exportProbe(cache, snapshot, output) {
  return cache.withRead(async () => {
    const manifest = await cache.readManifest(snapshot);
    const fileUrl = `https://www.figma.com/design/${snapshot.fileKey}/Benchmark`;
    const handle = await open(output, 'wx', 0o600);
    let total = 0, records = 0, pending = '', stream;
    const decoder = new StringDecoder('utf8');
    const write = async text => {
      total += Buffer.byteLength(text);
      if (total > 64 * 1024 * 1024) throw new Error('Benchmark probe exceeds decoder limit');
      await handle.writeFile(text);
    };
    try {
      await write(JSON.stringify({ version: 2, dropped: 0, fileUrl }).slice(0, -1) + ',"events":[');
      for (let i = 0; i < manifest.parts.length; i++) {
        pending += decoder.write(await cache.readPart(snapshot, i));
        let end;
        while ((end = pending.indexOf('\n')) !== -1) {
          if (end > 16 * 1024 * 1024 || ++records > 10000) throw new Error('Benchmark record limit');
          const event = JSON.parse(pending.slice(0, end)); pending = pending.slice(end + 1);
          const key = JSON.stringify([event.session, event.requestId]);
          if (stream === undefined) {
            stream = key;
            await write(JSON.stringify({ kind: 'ws-open', key, url: `wss://www.figma.com/api/multiplayer/${snapshot.fileKey}` }));
          }
          if (key !== stream || event.kind !== 'ws-received') throw new Error('Benchmark requires one complete stream');
          await write(',' + JSON.stringify({ kind: event.kind, key, opcode: event.opcode, payload: event.payload }));
        }
        if (pending.length > 16 * 1024 * 1024) throw new Error('Benchmark record limit');
      }
      pending += decoder.end();
      if (pending || !records) throw new Error('Incomplete benchmark stream');
      await write(']}');
      return { captureFile: output, fileUrl, events: records, bytes: total };
    } finally { await handle.close(); }
  });
}
