const fs = require("node:fs/promises");
const { createHash } = require("node:crypto");
const { StringDecoder } = require("node:string_decoder");
const { setImmediate: yieldToRequests } = require("node:timers/promises");

const CHUNK_BYTES = 64 * 1024;

function signature(stat) {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

// One in-flight read per path shares the dashboard's request fan-out. Parsing
// yields between bounded chunks so a cold/replaced queue cannot monopolize the
// HTTP event loop. Keep committed newline-terminated rows separate from a tail
// that a concurrent writer may still be completing.
function createAsyncQueueReader({ parseRow, label, maxEntries = 4 }) {
  const cache = new Map();
  const pending = new Map();

  async function hashPrefix(file, length) {
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    let position = 0;
    while (position < length) {
      const { bytesRead } = await file.read(buffer, 0, Math.min(CHUNK_BYTES, length - position), position);
      if (!bytesRead) throw new Error("Queue truncated during validation");
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
      await yieldToRequests();
    }
    return hash;
  }

  async function load(queuePath) {
    const cached = cache.get(queuePath);
    let file;
    try {
      file = await fs.open(queuePath, "r");
      // Stat the opened file, rather than a path which can be atomically replaced
      // between stat and open. Its signature always describes the bytes we read.
      const stat = await file.stat({ bigint: true });
      const nextSignature = signature(stat);
      const identity = `${stat.dev}:${stat.ino}`;
      const size = Number(stat.size);
      if (cached?.signature === nextSignature) {
        // Windows can reuse mtime/ctime for same-size writes anywhere in the
        // file. Validate every byte before reusing the parsed snapshot.
        const hash = await hashPrefix(file, size);
        if (hash.digest("hex") === cached.digest) return cached.rows;
      }
      let offset = 0;
      let seen = new Map();
      let hash = createHash("sha256");
      if (cached && cached.identity === identity && size > cached.size && cached.consumedBytes > 0) {
        // Growth can include an interior rewrite, so verify the entire old
        // committed prefix before parsing only the new tail.
        const prefixHash = await hashPrefix(file, cached.consumedBytes);
        if (prefixHash.copy().digest("hex") === cached.committedDigest) {
          offset = cached.consumedBytes;
          seen = cached.seen;
          hash = prefixHash;
        }
      }
      let committedHash = hash.copy();

      const changes = new Map();
      let malformed = 0;
      function parse(line, target) {
        if (!line.trim()) return;
        try {
          const entry = parseRow(JSON.parse(line));
          if (entry) target.set(entry.key, entry.row);
        } catch { malformed++; }
      }

      const decoder = new StringDecoder("utf8");
      const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
      let remainder = "";
      let position = offset;
      let consumedBytes = offset;
      while (position < size) {
        const length = Math.min(CHUNK_BYTES, size - position);
        const { bytesRead } = await file.read(buffer, 0, length, position);
        if (!bytesRead) throw new Error("Queue truncated during read");
        const newline = buffer.lastIndexOf(0x0a, bytesRead - 1);
        const chunk = buffer.subarray(0, bytesRead);
        if (newline >= 0) {
          consumedBytes = position + newline + 1;
          committedHash = hash.copy().update(chunk.subarray(0, newline + 1));
        }
        hash.update(chunk);
        position += bytesRead;
        remainder += decoder.write(chunk);
        let start = 0;
        let end;
        while ((end = remainder.indexOf("\n", start)) !== -1) {
          parse(remainder.slice(start, end), changes);
          start = end + 1;
        }
        remainder = remainder.slice(start);
        await yieldToRequests();
      }
      remainder += decoder.end();
      for (const [key, row] of changes) seen.set(key, row);
      const tail = new Map();
      parse(remainder, tail);
      // Legacy files without a final newline are readable, but their provisional
      // key never enters the committed map (completion may change that key).
      const rows = tail.size ? Array.from(new Map([...seen, ...tail]).values()) : Array.from(seen.values());
      cache.delete(queuePath);
      cache.set(queuePath, {
        signature: nextSignature, identity, size, consumedBytes,
        digest: hash.digest("hex"), committedDigest: committedHash.digest("hex"), seen, rows,
      });
      while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
      if (malformed) console.error(`[LocalAPI] ${label}: skipped ${malformed} malformed line(s)`);
      return rows;
    } catch (error) {
      if (error.code === "ENOENT") {
        cache.delete(queuePath);
        return [];
      }
      console.error(`[LocalAPI] ${label}: failed to read queue:`, error.message);
      return cached?.rows || [];
    } finally {
      if (file) await file.close();
    }
  }

  return function read(queuePath) {
    if (pending.has(queuePath)) return pending.get(queuePath);
    const task = load(queuePath).finally(() => pending.delete(queuePath));
    pending.set(queuePath, task);
    return task;
  };
}

module.exports = { createAsyncQueueReader };
