const { onlyMethod, publicError, rpc, sendJson, supabase } = require("../lib/api");

module.exports = async function handler(req, res) {
  if (!onlyMethod(req, res, "GET")) return;
  try {
    const orderId = req.query && req.query.order_id;
    if (typeof orderId !== "string" || !/^[0-9a-f-]{36}$/i.test(orderId)) {
      return sendJson(res, 400, { error: "Identificador de compra no válido." });
    }
    await rpc("release_expired_orders", {});
    const orders = await supabase(`/rest/v1/purchase_orders?id=eq.${encodeURIComponent(orderId)}&select=status,product_name,quantity,total_cents,currency&limit=1`);
    if (!orders.length) return sendJson(res, 404, { error: "No se encontró la compra." });
    const order = orders[0];
    return sendJson(res, 200, {
      status: order.status,
      product_name: order.product_name,
      quantity: order.quantity,
      total_cents: order.total_cents,
      currency: order.currency
    });
  } catch (error) {
    return publicError(error, res);
  }
};
