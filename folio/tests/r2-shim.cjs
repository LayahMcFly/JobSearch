/* A stand-in for a Cloudflare R2 bucket: files kept in memory. It supports the few calls the Worker uses (put, head, get with a
   range, delete). It is NOT R2: it shows nothing about real R2 limits, latency or billing. */
function makeR2() {
  const files = new Map(), st = { puts: 0, failDelete: false };
  async function toBuf(body) {
    if (body == null) return Buffer.alloc(0);
    if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return Buffer.from(body.buffer ? Buffer.from(body.buffer, body.byteOffset, body.byteLength) : body);
    const chunks = []; const rd = body.getReader(); for (;;) { const { done, value } = await rd.read(); if (done) break; chunks.push(Buffer.from(value)); } return Buffer.concat(chunks);
  }
  const rangeOf = (opt, size) => {
    if (!opt || !opt.range) return null; let r = opt.range;
    if (typeof r.get === 'function') { const m = /^bytes=(\d*)-(\d*)$/.exec(r.get('range') || ''); if (!m) throw new Error('bad range'); const a = m[1] === '' ? Math.max(0, size - Number(m[2])) : Number(m[1]), b = m[1] === '' || m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1); if (a >= size) throw new Error('unsatisfiable'); return { offset: a, length: b - a + 1 }; }
    return { offset: r.offset || 0, length: Math.min(r.length === undefined ? size : r.length, size - (r.offset || 0)) };
  };
  return {
    _files: files, _st: st,
    async put(key, body, opt) { st.puts++; const b = await toBuf(body); files.set(key, { buf: b, type: opt && opt.httpMetadata && opt.httpMetadata.contentType }); return { key, size: b.length }; },
    async head(key) { const f = files.get(key); return f ? { key, size: f.buf.length, httpMetadata: { contentType: f.type } } : null; },
    async get(key, opt) {
      const f = files.get(key); if (!f) return null; const r = rangeOf(opt, f.buf.length), part = r ? f.buf.subarray(r.offset, r.offset + r.length) : f.buf;
      return { key, size: f.buf.length, httpEtag: '"e-' + f.buf.length + '"', range: r || undefined, httpMetadata: { contentType: f.type }, body: new Response(part).body, arrayBuffer: async () => part.buffer.slice(part.byteOffset, part.byteOffset + part.length) };
    },
    async delete(k) { if (st.failDelete) throw new Error('R2 delete failed'); for (const x of Array.isArray(k) ? k : [k]) files.delete(x); }
  };
}
module.exports = { makeR2 };
