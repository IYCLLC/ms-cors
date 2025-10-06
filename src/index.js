#!/usr/bin/env node

const express = require("express");
const { createProxyMiddleware } = require("http-proxy-middleware");
const { Command } = require("commander");
const http = require("http");

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

// Parse cors-anywhere style URLs
app.use("/", (req, res, next) => {
  const fullPath = req.url;
  const pathWithoutSlash = fullPath.substring(1);
  const targetMatch = pathWithoutSlash.match(/^(https?:\/\/[^\/]+)(\/.*)?$/);
  if (targetMatch) {
    const targetOrigin = targetMatch[1];
    const targetPath = targetMatch[2] || "/";
    req.targetOrigin = targetOrigin;
    req.url = targetPath;
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

const targetOrigin = "https://ws-dev.messagespring.com/";
const WS_PATH = "/api/chat/socket.io";

const wsProxy = createProxyMiddleware({
  target: targetOrigin,
  changeOrigin: true,
  ws: true,
  secure: true,
  logLevel: "debug",

  pathRewrite: (rawPath, req) => {

    let path = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
    // Remove proxy prefix (e.g. /https://ws-dev.messagespring.com)
    path = path.replace(/^\/https?:\/\/[^/]+/, "");

    // Normalize: make sure all WS routes end up under /api/chat/socket.io
    if (path.startsWith(WS_PATH)) return path;
    return path.replace(/^\/socket\.io/, WS_PATH);
  },

  // Helpful logs during WS upgrade
  onProxyReqWs: (proxyReq, req, socket, options, head) => {
    // @ts-ignore
    const finalPath = proxyReq.path || req.url;
    console.log(`➡️  WS → ${targetOrigin}${finalPath}`);
  },
});

app.use(["/socket.io", "/api/chat/socket.io"], wsProxy);

app.use("/", dynamicProxy);

// Create HTTP server manually to handle WebSocket upgrade events
const server = http.createServer(app);

// Forward WebSocket upgrade events
server.on("upgrade", wsProxy.upgrade);

server.listen(port, host, () => {
  console.log(`🚀 Proxy server running on http://${host}:${port}`);
  console.log(`Usage: http://${host}:${port}/http://target-host/path`);
  console.log("Supports WebSocket forwarding ✅");
});
