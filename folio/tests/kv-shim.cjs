/* A stand-in for a Cloudflare Workers KV namespace: values kept in memory. It supports the calls the Worker uses (put, get as an
   array buffer, delete). It is NOT KV: it shows nothing about real KV limits, caching delays or billing. */
function makeKV() {
  const files = new Map(), st = { puts: 0, failDelete: false };
  return {
    _files: files, _st: st,
    async put(key, value) { st.puts++; if (!(value instanceof ArrayBuffer)) throw new Error('shim: only ArrayBuffer values'); if (value.byteLength > 25 * 1024 * 1024) throw new Error('KV value too large'); files.set(key, Buffer.from(value)); },
    async get(key, opt) { const f = files.get(key); if (!f) return null; if (!opt || opt.type !== 'arrayBuffer') throw new Error('shim: only type arrayBuffer'); return f.buffer.slice(f.byteOffset, f.byteOffset + f.byteLength); },
    async delete(key) { if (st.failDelete) throw new Error('KV delete failed'); files.delete(key); }
  };
}
module.exports = { makeKV };
