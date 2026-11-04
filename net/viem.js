// viem is loaded lazily from the import map so solo mode (and a dead CDN) never block the page.
let cached;
export function loadViem() {
  cached ??= Promise.all([import("viem"), import("viem/accounts")]).then(([v, a]) => ({
    ...v,
    generatePrivateKey: a.generatePrivateKey,
    privateKeyToAccount: a.privateKeyToAccount,
  }));
  cached.catch(() => { cached = undefined; });
  return cached;
}
