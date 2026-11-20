// A stand-in for a Cloudflare KV namespace (where photo files live), covering
// the calls the shop uses: put, getWithMetadata, get, delete.

export class KVShim {
  constructor() {
    this.map = new Map();
  }

  async put(key, value, opts = {}) {
    const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    this.map.set(key, { bytes: bytes.slice(), metadata: opts.metadata ?? null });
  }

  async getWithMetadata(key, opts = {}) {
    const type = typeof opts === 'string' ? opts : opts.type || 'text';
    const e = this.map.get(key);
    if (!e) return { value: null, metadata: null };
    let value;
    if (type === 'stream') value = new Blob([e.bytes]).stream();
    else if (type === 'arrayBuffer') value = e.bytes.buffer.slice(0);
    else value = new TextDecoder().decode(e.bytes);
    return { value, metadata: e.metadata };
  }

  async get(key, opts) {
    return (await this.getWithMetadata(key, opts)).value;
  }

  async delete(key) {
    this.map.delete(key);
  }
}
