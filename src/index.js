#!/usr/bin/env node

const express = require("express");
const { createProxyMiddleware } = require("http-proxy-middleware");
const { Command } = require("commander");

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
  .option(
    "--fix-cookies",
    "fix cookie domains for localhost development",
    true,
  )
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

// Middleware to parse cors-anywhere style URLs
app.use("/", (req, res, next) => {
  const fullPath = req.url;
  const pathWithoutSlash = fullPath.substring(1);
  const targetMatch = pathWithoutSlash.match(/^(https?:\/\/[^\/]+)(\/.*)?$/);

  if (targetMatch) {
    const targetOrigin = targetMatch[1];
    const targetPath = targetMatch[2] || "/";

    req.targetOrigin = targetOrigin;
    req.targetPath = targetPath;
    req.url = targetPath;

    next();
  } else {
    res.status(400).json({
      error:
        "Invalid URL format. Use: http://localhost:8080/http://target-host/path",
    });
  }
});

// Dynamic proxy middleware
app.use("/", (req, res, next) => {
  if (!req.targetOrigin) {
    return next();
  }

  const proxy = createProxyMiddleware({
    target: req.targetOrigin,
    changeOrigin: true,
    secure: false,
    logLevel: "silent",
    on: {
      proxyReq: (proxyReq, req, res) => {
        // Remove origin header so backend doesn't reject localhost
        proxyReq.removeHeader("origin");
      },
      proxyRes: (proxyRes, req, res) => {
        // Override CORS headers
        proxyRes.headers["access-control-allow-origin"] = allowedOrigin;
        proxyRes.headers["access-control-allow-credentials"] = "true";
        proxyRes.headers["access-control-allow-methods"] =
          "GET, POST, PUT, DELETE, OPTIONS";
        proxyRes.headers["access-control-allow-headers"] =
          "Content-Type, Authorization, X-Requested-With";

        // Fix cookie domain for localhost development
        if (fixCookies && proxyRes.headers["set-cookie"]) {
          proxyRes.headers["set-cookie"] = proxyRes.headers["set-cookie"].map(
            (cookie) =>
              cookie
                .replace(`Domain=${cookieDomain}`, "Domain=localhost")
                .replace("Secure;", ""), // Remove Secure flag for HTTP localhost
          );
        }
      },
      error: (err, req, res) => {
        console.error("Proxy error:", err.message);
        res.status(500).json({ error: "Proxy error: " + err.message });
      },
    },
  });

  proxy(req, res, next);
});

app.listen(port, host, () => {
  console.log(`Proxy server running on http://${host}:${port}`);
  console.log("Usage: http://localhost:8080/http://target-host/path");
});
