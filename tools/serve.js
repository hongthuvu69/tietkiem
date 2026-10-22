// Server tĩnh để thử web app trên máy: node tools/serve.js  →  http://localhost:8090
// App vẫn đồng bộ với Supabase thật (cấu hình trong docs/js/config.js).
const http = require("http");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..", "docs");
const port = Number(process.env.PORT) || 8090;
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
};

http
  .createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (p.endsWith("/")) p += "index.html";
    const file = path.join(root, p);
    if (!file.startsWith(root)) {
      res.writeHead(403).end();
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404).end("Not found");
        return;
      }
      res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
      res.end(data);
    });
  })
  .listen(port, () => console.log(`Tiết Kiệm web: http://localhost:${port}`));
