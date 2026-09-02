import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type RequestListener, type Server } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const defaultStaticRoot = fileURLToPath(
  new URL("../../studio/dist/", import.meta.url),
);

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

const fileSystemFailureSchema = z.object({ code: z.string() }).passthrough();
const tcpAddressSchema = z.object({ port: z.number().int().positive() });

export interface RunningStaticServer {
  origin: string;
  close: () => Promise<void>;
}

export function createStaticHandler(
  staticRoot = defaultStaticRoot,
): RequestListener {
  const root = resolve(staticRoot);

  return (request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { allow: "GET, HEAD" }).end();
      return;
    }

    void (async () => {
      try {
        const url = new URL(request.url ?? "/", "http://renderer.local");
        const pathname = decodeURIComponent(url.pathname);
        const relativePath =
          pathname === "/" ? "render.html" : pathname.slice(1);
        const filePath = resolve(root, relativePath);

        if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) {
          response.writeHead(403).end();
          return;
        }

        const fileStat = await stat(filePath);
        if (!fileStat.isFile()) {
          response.writeHead(404).end();
          return;
        }

        response.writeHead(200, {
          "cache-control": "no-store",
          "content-length": fileStat.size,
          "content-type":
            contentTypes.get(extname(filePath).toLowerCase()) ??
            "application/octet-stream",
        });

        if (request.method === "HEAD") {
          response.end();
          return;
        }

        const stream = createReadStream(filePath);
        stream.on("error", () => response.destroy());
        stream.pipe(response);
      } catch (error) {
        const failure = fileSystemFailureSchema.safeParse(error);
        response
          .writeHead(
            failure.success && failure.data.code === "ENOENT" ? 404 : 400,
          )
          .end();
      }
    })();
  };
}

export async function startStaticServer(
  staticRoot = defaultStaticRoot,
): Promise<RunningStaticServer> {
  const server = createServer(createStaticHandler(staticRoot));
  await listen(server, 0, "127.0.0.1");
  const address = tcpAddressSchema.safeParse(server.address());
  if (!address.success) {
    await close(server);
    throw new Error("Static server did not bind to a TCP port");
  }

  return {
    origin: `http://127.0.0.1:${address.data.port}`,
    close: () => close(server),
  };
}

export function boundTcpPort(server: Server): number {
  return tcpAddressSchema.parse(server.address()).port;
}

export function listen(
  server: Server,
  port: number,
  host: string,
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolvePromise();
    });
  });
}

export function close(server: Server): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    server.close((error) => (error ? reject(error) : resolvePromise()));
  });
}
