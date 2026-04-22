// Minimal node:net shim for CF Workers.
// Only Socket is needed — Next.js passes it to the http shim's
// IncomingMessage as `socket` but never actually connects.

import { EventEmitter } from "node:events";

export class Socket extends EventEmitter {
  constructor() {
    super();
    this.writable = true;
    this.readable = true;
    this.encrypted = false;
    this.remoteAddress = "127.0.0.1";
    this.remotePort = 0;
    this.localAddress = "127.0.0.1";
    this.localPort = 0;
  }
  address() { return { address: "127.0.0.1", family: "IPv4", port: 443 }; }
  connect() { return this; }
  write() { return true; }
  end() { this.emit("close"); return this; }
  destroy() { this.emit("close"); return this; }
  setTimeout() { return this; }
  setNoDelay() { return this; }
  setKeepAlive() { return this; }
  ref() { return this; }
  unref() { return this; }
}

export class Server extends EventEmitter {
  constructor() { super(); }
  listen() { return this; }
  close() { return this; }
  address() { return null; }
}

export function createServer() { return new Server(); }
export function createConnection() { return new Socket(); }
export function connect() { return new Socket(); }
export function isIP() { return 0; }
export function isIPv4() { return false; }
export function isIPv6() { return false; }

export default { Socket, Server, createServer, createConnection, connect, isIP, isIPv4, isIPv6 };
