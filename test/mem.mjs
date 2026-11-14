export const memStore = () => {
  const m = new Map();
  return {
    async get(k, o) { return m.has(k) ? JSON.parse(m.get(k)) : null; },
    // Comme Netlify Blobs : { onlyIfNew: true } n'écrase pas une clé existante
    async setJSON(k, v, opts = {}) {
      if (opts.onlyIfNew && m.has(k)) return { modified: false };
      m.set(k, JSON.stringify(v));
      return { modified: true };
    },
    async delete(k) { m.delete(k); },
    async list({ prefix = "" } = {}) { return { blobs: [...m.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) }; },
    _m: m,
  };
};
