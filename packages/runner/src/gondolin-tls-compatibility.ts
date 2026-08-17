import type { Duplex } from "node:stream";
import tls from "node:tls";

export const GONDOLIN_TLS_COMPATIBILITY = {
  denoVersion: "2.9.5",
  gondolinVersion: "0.12.0",
} as const;

let installed = false;

interface RestartableTlsSocket {
  _start(): void;
}

/**
 * Restores Node's async-SNI handshake behavior for Gondolin's custom Duplex.
 *
 * Gondolin 0.12.0 creates a server TLSSocket over GuestTlsStream and supplies
 * its per-host SecureContext asynchronously through SNICallback. Node resumes
 * the paused handshake after that callback; Deno 2.9.5 does not, so no HTTP
 * plaintext reaches Gondolin's mediation hooks until private _start() is
 * called. This changes handshake scheduling only; it does not relax TLS
 * verification or the HTTP request policy.
 *
 * This is a process-wide monkey patch against a private Deno API. Before
 * changing either validated version, follow the compatibility review and
 * removal checklist in docs/runner-release.md. The version-gate test is
 * intentionally expected to fail on an unreviewed Deno or Gondolin upgrade.
 */
export function installGondolinTlsCompatibility(): void {
  if (installed) return;
  if (Deno.version.deno !== GONDOLIN_TLS_COMPATIBILITY.denoVersion) {
    throw new Error(
      `The Gondolin TLS compatibility shim is validated only with Deno ${GONDOLIN_TLS_COMPATIBILITY.denoVersion}; found ${Deno.version.deno}. Follow the compatibility review in docs/runner-release.md before using GitHub mediation with a different Deno version.`,
    );
  }

  const NativeTlsSocket = tls.TLSSocket;
  class DenoCompatibleTlsSocket extends NativeTlsSocket {
    constructor(socket: Duplex, options: tls.TLSSocketOptions = {}) {
      const sniCallback = options.SNICallback;
      const instance: { current?: DenoCompatibleTlsSocket } = {};
      super(
        socket,
        sniCallback
          ? {
            ...options,
            SNICallback(servername, callback) {
              let returned = false;
              sniCallback(servername, (error, context) => {
                callback(error, context);
                if (returned && !error) {
                  (instance.current as unknown as RestartableTlsSocket)._start();
                }
              });
              returned = true;
            },
          }
          : options,
      );
      instance.current = this;
    }
  }

  Object.defineProperty(tls, "TLSSocket", {
    configurable: true,
    writable: true,
    value: DenoCompatibleTlsSocket,
  });
  installed = true;
}
