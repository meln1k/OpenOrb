import type { Duplex } from "node:stream";
import tls from "node:tls";

import { isSupportedDenoVersion, MINIMUM_DENO_VERSION } from "@/src/runtime/deno-version.ts";

export const GONDOLIN_TLS_COMPATIBILITY = {
  gondolinVersion: "0.12.0",
} as const;

let installed = false;

class GondolinTlsCompatibilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GondolinTlsCompatibilityError";
  }
}

interface TlsSocketReference {
  current?: tls.TLSSocket;
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
 * upgrading the release toolchain or Gondolin, follow the compatibility review
 * and removal checklist in docs/runner-release.md. Newer stable Deno releases
 * are accepted; the private restart-method check remains in place.
 */
export function installGondolinTlsCompatibility(): void {
  if (installed) return;
  if (!isSupportedDenoVersion(Deno.version.deno)) {
    throw new GondolinTlsCompatibilityError(
      `The Gondolin TLS compatibility shim requires stable Deno ${MINIMUM_DENO_VERSION} or newer; found ${Deno.version.deno}.`,
    );
  }

  const NativeTlsSocket = tls.TLSSocket;
  class DenoCompatibleTlsSocket extends NativeTlsSocket {
    constructor(socket: Duplex, options: tls.TLSSocketOptions = {}) {
      const sniCallback = options.SNICallback;
      const instance: TlsSocketReference = {};
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
                  restartTlsSocket(instance.current);
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

function restartTlsSocket(socket: tls.TLSSocket | undefined): void {
  if (!socket || !("_start" in socket) || !(socket._start instanceof Function)) {
    throw new GondolinTlsCompatibilityError(
      "Deno's private TLS handshake restart method is unavailable.",
    );
  }
  socket._start.call(socket);
}
