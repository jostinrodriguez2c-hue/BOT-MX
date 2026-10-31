const { body, onlyMethod, publicError, requireWorkerPermission, rpc, sendJson } = require("../lib/api");

module.exports = async function handler(req, res) {
  if (!onlyMethod(req, res, "POST")) return;
  try {
    await requireWorkerPermission(req, "sales_register");
    const payload = body(req);
    if (typeof payload.product_id !== "string" || !Number.isSafeInteger(payload.quantity) || payload.quantity < 1) {
      return sendJson(res, 400, { error: "Selecciona un producto y una cantidad válida." });
    }
    await rpc("register_manual_sale", {
      p_product_id: payload.product_id,
      p_quantity: payload.quantity
    });
    return sendJson(res, 200, { ok: true });
  } catch (error) {
    return publicError(error, res);
  }
};
