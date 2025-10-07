#!/usr/bin/env node

const express = require("express");
const { createProxyMiddleware } = require("http-proxy-middleware");
const { Command } = require("commander");
const http = require("http");
const WebSocket = require("ws");

const program = new Command();

program
  .name("ms-cors")
  .description(
    'CORS proxy server for development\n\nUsage example:\n  ms-cors --port 3001 --origin "https://myapp.com"\n  curl "http://localhost:3001/https://api.example.com/data"',
  )
  .version("1.0.0")
  .option("-H, --host <host>", "host to bind to", "0.0.0.0")
  .option("-p, --port <port>", "port to listen on", "8080")
  .option(
    "-o, --origin <origin>",
    "allowed origin for CORS",
    "http://localhost:3000",
  )
  .option("--fix-cookies", "fix cookie domains for localhost development", true)
  .option(
    "--cookie-domain <domain>",
    "domain to replace in cookies",
    ".messagespring.com",
  )
  .helpOption("-h, --help", "display help for command")
  .parse();

const options = program.opts();
const host = options.host;
const port = parseInt(options.port);
const allowedOrigin = options.origin;
const fixCookies = options.fixCookies;
const cookieDomain = options.cookieDomain;

const app = express();

// Parse cors-anywhere style URLs (format: /https://target.com/path)
function parseCorsAnywhereUrl(url) {
  const pathWithoutSlash = url.startsWith("/") ? url.substring(1) : url;
  const match = pathWithoutSlash.match(/^(https?:\/\/[^\/]+)(\/.+)?$/);

  if (match) {
    return {
      targetOrigin: match[1],
      targetPath: match[2] || "/",
    };
  }
  return null;
}

// Parse cors-anywhere style URLs
app.use("/", (req, res, next) => {
  const parsed = parseCorsAnywhereUrl(req.url);
  if (parsed) {
    req.targetOrigin = parsed.targetOrigin;
    req.url = parsed.targetPath;
    next();
  } else {
    res.status(400).json({
      error:
        "Invalid URL format. Use: http://localhost:8080/http://target-host/path",
    });
  }
});

// Dynamic proxy middleware with WebSocket support
const dynamicProxy = (req, res, next) => {
  if (!req.targetOrigin) return next();

  const proxy = createProxyMiddleware({
    target: req.targetOrigin,
    changeOrigin: true,
    ws: true, // 🔥 Enable WebSocket forwarding
    secure: false,
    logLevel: "silent",
    on: {
      proxyReq: (proxyReq, req) => {
        // Remove origin header so backend doesn't reject localhost
        proxyReq.removeHeader("origin");
      },
      proxyRes: (proxyRes) => {
        // Override CORS headers
        proxyRes.headers["access-control-allow-origin"] = allowedOrigin;
        proxyRes.headers["access-control-allow-credentials"] = "true";
        proxyRes.headers["access-control-allow-methods"] =
          "GET, POST, PUT, PATCH, DELETE, OPTIONS";

        // Fix cookie domain for localhost development
        if (fixCookies && proxyRes.headers["set-cookie"]) {
          proxyRes.headers["set-cookie"] = proxyRes.headers["set-cookie"].map(
            (cookie) =>
              cookie
                .replace(`Domain=${cookieDomain}`, "Domain=localhost")
                .replace("Secure;", ""),
          );
        }
      },
      error: (err, req, res) => {
        console.error("Proxy error:", err);
        if (!res.headersSent)
          res.status(500).json({ error: "Proxy error: " + err.message });
      },
    },
  });

  proxy(req, res, next);
};

// Create HTTP server manually to handle WebSocket upgrade events
const server = http.createServer(app);

// WebSocket server for handling upgrades
const wss = new WebSocket.Server({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  console.log(`🔌 Upgrade request URL: ${req.url}`);

  // Parse target from URL using shared parser
  const parsed = parseCorsAnywhereUrl(req.url);
  if (!parsed) {
    console.error(`❌ Invalid URL format: ${req.url}`);
    socket.destroy();
    return;
  }

  const { targetOrigin, targetPath } = parsed;
  const targetUrl = new URL(targetOrigin);

  console.log(`📍 WebSocket target: ${targetOrigin}${targetPath}`);

  wss.handleUpgrade(req, socket, head, (clientWs) => {
    console.log(`✅ Client WebSocket established`);

    // Emit connection event
    wss.emit("connection", clientWs, req);

    // Create WebSocket connection to target server
    const targetWsUrl = `${targetUrl.protocol === "https:" ? "wss:" : "ws:"}//${targetUrl.host}${targetPath}`;
    console.log(`➡️  Connecting to: ${targetWsUrl}`);

    const forwardHeaders = {};

    // Forward cookies if present
    if (req.headers.cookie) {
      console.log('cookie', req.headers.cookie)
      forwardHeaders.cookie = req.headers.cookie;
    }

    console.log(`📋 Forward headers:`, forwardHeaders);

    const targetWs = new WebSocket(targetWsUrl, {
      headers: forwardHeaders,
      rejectUnauthorized: false,
    });

    targetWs.on("open", () => {
      console.log(`✅ Connected to target server`);
    });

    targetWs.on("unexpected-response", (req, res) => {
      console.error(`❌ Unexpected response from target: ${res.statusCode}`);
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => console.error(`Response body: ${body}`));
      clientWs.close();
    });

    // Client → Server: Strip namespace from packets
    clientWs.on("message", (data) => {
      let message = data.toString();
      const namespacePattern = /^(4\d)(\/https?:\/\/[^,]+)(,.*)?$/;

      if (namespacePattern.test(message)) {
        message = message.replace(namespacePattern, "$1/$3");
        console.log(`🔧 Client→Server: ${data.toString()} → ${message}`);
      } else {
        console.log(`📤 Client→Server: ${message}`);
      }

      if (targetWs.readyState === WebSocket.OPEN) {
        targetWs.send(message);
      }
    });

    // Server → Client: Add namespace back to packets
    targetWs.on("message", (data) => {
      let message = data.toString();
      const connectPattern = /^(4\d)(\/)(,.*)?$/;

      if (connectPattern.test(message)) {
        message = message.replace(connectPattern, `$1/${targetOrigin}$3`);
        console.log(`🔧 Server→Client: ${data.toString()} → ${message}`);
      } else {
        console.log(`📥 Server→Client: ${message}`);
      }

      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(message);
      }
    });

    clientWs.on("close", () => {
      console.log(`❌ Client closed`);
      targetWs.close();
    });

    targetWs.on("close", () => {
      console.log(`❌ Target closed`);
      clientWs.close();
    });

    clientWs.on("error", (err) => {
      console.error(`Client error:`, err.message);
      targetWs.close();
    });

    targetWs.on("error", (err) => {
      console.error(`Target error:`, err.message);
      clientWs.close();
    });
  });
});

server.listen(port, host, () => {
  console.log(`🚀 Proxy server running on http://${host}:${port}`);
  console.log(`Usage: http://${host}:${port}/http://target-host/path`);
  console.log("Supports WebSocket forwarding ✅");
});
