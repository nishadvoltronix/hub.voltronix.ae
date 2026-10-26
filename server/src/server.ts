import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import { createApp, type AppDependencies } from "./app.js";
import { validateConfig, type ApiConfig } from "./config.js";

export const shutdownDeadlineMs = 5_000;

/** Owns HTTP sockets only. A future DB owner needs a separately tested transaction drain. */
export function createHttpLifecycle(server: Server) {
  const sockets = new Set<Socket>();
  server.on("connection", socket => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (_request, socket) => socket.destroy());
  let stopping: Promise<void> | undefined;
  return {
    stop(deadlineMs = shutdownDeadlineMs): Promise<void> {
      if (stopping) return stopping;
      if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > shutdownDeadlineMs) {
        return Promise.reject(new Error("Invalid shutdown deadline."));
      }
      stopping = new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(() => {
          for (const socket of sockets) socket.destroy();
        }, deadlineMs);
        server.close(error => {
          clearTimeout(deadline);
          if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
            reject(new Error("Local API shutdown failed."));
          } else resolve();
        });
      });
      return stopping;
    },
  };
}

export async function startServer(input: ApiConfig, dependencies: AppDependencies = {}, release = async () => {}) {
  const config = validateConfig(input);
  const server = createServer({
    maxHeaderSize: 16_384, requestTimeout: 10_000, headersTimeout: 5_000,
    keepAliveTimeout: 1_000, requireHostHeader: true, connectionsCheckingInterval: 1_000,
  }, createApp(config, dependencies));
  server.maxRequestsPerSocket = 100;
  const lifecycle = createHttpLifecycle(server);
  let stopping: Promise<void> | undefined;
  const stop = (deadlineMs = shutdownDeadlineMs): Promise<void> => {
    stopping ??= lifecycle.stop(deadlineMs).finally(release);
    return stopping;
  };
  let failed = false;
  // Errors after listen must not become an uncaught event or leak Node's error text.
  const runtimeFailure = () => {
    failed = true;
    void stop().catch(() => { /* failure is exposed only as a boolean */ });
  };
  try {
    await new Promise<void>((resolve, reject) => {
      const failed = () => reject(new Error("Local API listener unavailable."));
      server.once("error", failed);
      server.listen(config.port, config.host, () => {
        server.on("error", runtimeFailure);
        server.off("error", failed);
        resolve();
      });
    });
  } catch {
    await stop();
    throw new Error("Local API listener unavailable.");
  }
  return { server, stop, get failed() { return failed; } };
}
