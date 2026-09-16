import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { privateSocketHeaders } from "./private-socket-policy";

export default defineConfig({
  plugins: [react()],
  // Fixed loopback-only IAP forward; never a public backend or credential proxy.
  server: { host: "127.0.0.1", port: 4311, strictPort: true,
    proxy: { "/v1": { target: "http://127.0.0.1:58080", changeOrigin: false, ws: true,
      configure(proxy) {
        proxy.on("proxyReqWs", (outbound, request, socket) => {
          // Native browser sockets cannot send an Authorization header. Only this
          // exact local development origin may receive the fixed synthetic identity.
          outbound.removeHeader("authorization");
          outbound.removeHeader("cookie");
          const headers = privateSocketHeaders({ mode: process.env.VITE_KAVAROUTES_BACKEND,
            url: request.url, host: request.headers.host, origin: request.headers.origin,
            protocol: request.headers["sec-websocket-protocol"], remoteAddress: request.socket.remoteAddress });
          if (!headers) { outbound.destroy(); socket.destroy(); return; }
          for (const [name, value] of Object.entries(headers)) outbound.setHeader(name, value);
        });
      },
    } } },
  preview: { host: "127.0.0.1", port: 4312, strictPort: true },
  build: { sourcemap: false, target: "es2022", reportCompressedSize: true },
});
