// Custom server wrapper for Next.js standalone.
// Adds WebSocket upgrade proxying for /ws -> mail-worker.
// Uses /ws (not /worker/ws) to avoid conflict with Next.js rewrites on /worker/:path*.
// Uses raw TCP tunneling (net.connect) to avoid frame corruption.
// The original standalone server.js is renamed to server.next.js at Docker build time.

const http = require("http");
const net = require("net");

const WORKER_URL = process.env.WORKER_INTERNAL_URL || process.env.MAIL_WORKER_URL || "http://mail-worker:4001";

function parseUrl(raw) {
  try {
    return new URL(raw);
  } catch {
    return new URL("http://mail-worker:4001");
  }
}

// Intercept the first http.Server.listen() call (from Next.js standalone)
// to attach a WebSocket upgrade handler before it starts listening.
const origListen = http.Server.prototype.listen;
http.Server.prototype.listen = function (...args) {
  // Restore immediately so only the first server is patched
  http.Server.prototype.listen = origListen;

  this.on("upgrade", (req, clientSocket, head) => {
    if (req.url !== "/ws") return;

    const target = parseUrl(WORKER_URL);
    const targetPort = parseInt(target.port) || 4001;
    const targetHost = target.hostname;

    // Open a raw TCP connection to the mail-worker
    const proxySocket = net.connect({ host: targetHost, port: targetPort }, () => {
      // Reconstruct the HTTP upgrade request to send to the backend
      const headers = Object.assign({}, req.headers, {
        host: targetPort === 80 ? targetHost : `${targetHost}:${targetPort}`,
      });

      let reqLine = "GET /ws HTTP/1.1\r\n";
      for (const [key, value] of Object.entries(headers)) {
        if (Array.isArray(value)) {
          for (const v of value) {
            reqLine += `${key}: ${v}\r\n`;
          }
        } else if (value != null) {
          reqLine += `${key}: ${value}\r\n`;
        }
      }
      reqLine += "\r\n";

      proxySocket.write(reqLine);
      if (head && head.length) {
        proxySocket.write(head);
      }

      // Pipe the raw TCP streams — the backend's 101 response and all
      // subsequent WebSocket frames flow through untouched.
      proxySocket.pipe(clientSocket);
      clientSocket.pipe(proxySocket);
    });

    proxySocket.on("error", () => {
      clientSocket.destroy();
    });
    clientSocket.on("error", () => {
      proxySocket.destroy();
    });
  });

  return origListen.apply(this, args);
};

// Load the original Next.js standalone server
require("./server.next.js");
