const { body, hashIp, onlyMethod, publicError, rpc, sendJson } = require("../lib/api");

module.exports = async function handler(req, res) {
  if (!onlyMethod(req, res, "POST")) return;
  try {
    const payload = body(req);
    if (typeof payload.product_id !== "string" || !/^[0-9a-f-]{36}$/i.test(payload.product_id)
      || !Number.isSafeInteger(payload.quantity) || payload.quantity < 1 || payload.quantity > 1000) {
      return sendJson(res, 400, { error: "El producto o la cantidad no son válidos." });
    }
    await rpc("register_demo_purchase", {
      p_product_id: payload.product_id,
      p_quantity: payload.quantity,
      p_ip_hash: hashIp(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "")
    });
    return sendJson(res, 200, { ok: true, simulated: true });
  } catch (error) {
    return publicError(error, res);
  }
};
