const crypto = require("node:crypto");
const { body, emailOtp, hashIp, onlyMethod, otpHash, publicError, rpc, sendJson, supabase } = require("../../lib/api");

module.exports = async function handler(req, res) {
  if (!onlyMethod(req, res, "POST")) return;
  return sendJson(res, 410, { error: "El pago está en modo de demostración: no se envían códigos ni se procesa un pago real." });
  try {
    const payload = body(req);
    const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
    const customerName = typeof payload.customer_name === "string" ? payload.customer_name.trim() : "";
    const contact = typeof payload.contact === "string" ? payload.contact.trim() : "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      return sendJson(res, 400, { error: "Escribe un correo electrónico válido." });
    }
    if (!customerName || customerName.length > 100 || !contact || contact.length > 120) {
      return sendJson(res, 400, { error: "Escribe tu nombre y un teléfono o medio de contacto." });
    }
    if (typeof payload.product_id !== "string" || !/^[0-9a-f-]{36}$/i.test(payload.product_id)
      || !Number.isSafeInteger(payload.quantity) || payload.quantity < 1 || payload.quantity > 1000) {
      return sendJson(res, 400, { error: "El producto o la cantidad no son válidos." });
    }
    const code = String(crypto.randomInt(100000, 1000000));
    const orderId = await rpc("create_purchase_request", {
      p_product_id: payload.product_id,
      p_quantity: payload.quantity,
      p_email: email,
      p_customer_name: customerName,
      p_contact: contact,
      p_otp_hash: "pending",
      p_otp_expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      p_ip_hash: hashIp(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "")
    });
    await supabase(`/rest/v1/purchase_orders?id=eq.${encodeURIComponent(orderId)}`, {
      method: "PATCH",
      body: JSON.stringify({ otp_hash: otpHash(orderId, code) })
    });
    try {
      await emailOtp(email, code);
    } catch (error) {
      await supabase(`/rest/v1/purchase_orders?id=eq.${encodeURIComponent(orderId)}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "cancelled" })
      });
      throw error;
    }
    return sendJson(res, 200, { order_id: orderId, message: "Te enviamos un código de un solo uso. Revisa tu correo." });
  } catch (error) {
    return publicError(error, res);
  }
};
