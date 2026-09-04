import type { GuigApi } from "../../shared/ipc.js";

function missing(name: string): () => Promise<never> {
  return () =>
    Promise.reject(new Error(`guig backend not connected (missing ${name})`));
}

/** Stand-in backend used until the preload exposes `window.guig`. */
export const apiStub: GuigApi = new Proxy({} as GuigApi, {
  get: (_target, prop) => missing(String(prop)),
});

export function getApi(): GuigApi {
  if (typeof window !== "undefined" && window.guig) return window.guig;
  return apiStub;
}
