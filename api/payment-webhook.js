const crypto = require("node:crypto");
const { getEnv, publicError, rpc, safeEqualHex, sendJson, supabase } = require("../lib/api");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return sendJson(res, 405, { error: "Method not allowed." });
  }
  return sendJson(res, 200, { received: true, demo_mode: true });
  try {
    const paymentId = req.query && req.query["data.id"];
    if (!paymentId || typeof paymentId !== "string" || !/^\d{1,32}$/.test(paymentId)) {
      return sendJson(res, 400, { error: "Falta el identificador de pago." });
    }
    if (!validSignature(req, paymentId)) {
      return sendJson(res, 401, { error: "Firma del webhook no válida." });
    }
    const response = await fetch(`https://api.mercadopago.com/v1/payments/${encodeURIComponent(paymentId)}`, {
      headers: { Authorization: `Bearer ${getEnv("MERCADOPAGO_ACCESS_TOKEN")}` }
    });
    const payment = await response.json();
    if (!response.ok) throw new Error("Mercado Pago no pudo validar el pago.");
    if (payment.status !== "approved") return sendJson(res, 200, { received: true });

    const orderId = payment.external_reference;
    if (typeof orderId !== "string" || !/^[0-9a-f-]{36}$/i.test(orderId)) {
      return sendJson(res, 400, { error: "La referencia de pago no es válida." });
    }
    const orders = await supabase(`/rest/v1/purchase_orders?id=eq.${encodeURIComponent(orderId)}&select=id,total_cents,currency&limit=1`);
    const order = orders[0];
    if (!order || order.currency !== "USD" || Math.round(Number(payment.transaction_amount) * 100) !== order.total_cents
      || payment.currency_id !== "USD") {
      return sendJson(res, 409, { error: "El importe o moneda no coincide con la compra." });
    }
    const status = await rpc("confirm_paid_purchase", {
      p_order_id: orderId,
      p_payment_id: String(payment.id),
      p_total_cents: order.total_cents
    });
    return sendJson(res, 200, { received: true, order_status: status });
  } catch (error) {
    return publicError(error, res);
  }
};

function validSignature(req, paymentId) {
  const signature = req.headers["x-signature"];
  const requestId = req.headers["x-request-id"];
  if (typeof signature !== "string" || typeof requestId !== "string") return false;
  const parts = Object.fromEntries(signature.split(",").map(part => {
    const [key, ...value] = part.trim().split("=");
    return [key, value.join("=")];
  }));
  if (!parts.ts || !/^[0-9a-f]{64}$/i.test(parts.v1 || "")) return false;
  const manifest = `id:${paymentId};request-id:${requestId};ts:${parts.ts};`;
  const expected = crypto.createHmac("sha256", getEnv("MERCADOPAGO_WEBHOOK_SECRET"))
    .update(manifest)
    .digest("hex");
  return safeEqualHex(parts.v1, expected);
}
