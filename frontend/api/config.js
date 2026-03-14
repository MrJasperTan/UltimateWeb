module.exports = function handler(_request, response) {
  const apiBase = String(process.env.ULTIMATEWEB_API_BASE || "").trim().replace(/\/+$/, "");
  response.setHeader("Content-Type", "application/javascript; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.status(200).send(`window.ULTIMATEWEB_API_BASE = ${JSON.stringify(apiBase)};`);
};
