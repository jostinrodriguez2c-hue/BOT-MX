const { body, getEnv, onlyMethod, otpHash, publicError, rpc, sendJson, supabase } = require("../../lib/api");

module.exports = async function handler(req, res) {
  if (!onlyMethod(req, res, "POST")) return;
  let orderId;
  try {
    const payload = body(req);
    orderId = typeof payload.order_id === "string" ? payload.order_id : "";
    const code = typeof payload.code === "string" ? payload.code.trim() : "";
    if (!/^[0-9a-f-]{36}$/i.test(orderId) || !/^\d{6}$/.test(code)) {
      return sendJson(res, 400, { error: "El código debe tener seis dígitos." });
    }
    const verified = await rpc("verify_purchase_code", {
      p_order_id: orderId,
      p_code_hash: otpHash(orderId, code)
    });
    if (!verified || !verified.ok) {
      const message = verified && verified.reason === "product_unavailable"
        ? "El producto ya no tiene existencias suficientes."
        : verified && verified.reason === "invalid_code"
          ? "El código no es correcto. Revisa tu correo e inténtalo de nuevo."
          : "El código venció o ya fue utilizado. Inicia una nueva compra.";
      return sendJson(res, 400, { error: message });
    }
    const order = verified.order;
    const orders = await supabase(`/rest/v1/purchase_orders?id=eq.${encodeURIComponent(order.id)}&select=email&limit=1`);
    if (!orders.length) throw new Error("No se encontró la compra después de confirmar el código.");
    const appUrl = getEnv("APP_URL").replace(/\/+$/, "");
    const backUrl = `${appUrl}/?order_id=${encodeURIComponent(order.id)}`;
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const accessToken = getEnv("MERCADOPAGO_ACCESS_TOKEN");
    const preferenceResponse = await fetch("https://api.mercadopago.com/checkout/preferences", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${getEnv("MERCADOPAGO_ACCESS_TOKEN")}`,
        "Content-Type": "application/json",
        "X-Idempotency-Key": order.id
      },
      body: JSON.stringify({
        external_reference: order.id,
        items: [{
          id: order.product_id,
          title: order.product_name,
          description: `Compra Wilcox Company: ${order.quantity} ${order.unit}`,
          quantity: 1,
          currency_id: "USD",
          unit_price: order.total_cents / 100
        }],
        payer: { email: orders[0].email },
        payment_methods: { installments: 1 },
        back_urls: {
          success: backUrl,
          failure: backUrl,
          pending: backUrl
        },
        auto_return: "approved",
        notification_url: `${appUrl}/api/payment-webhook`,
        expires: true,
        expiration_date_from: new Date().toISOString(),
        expiration_date_to: expiresAt
      })
    });
    const preference = await preferenceResponse.json();
    const checkoutUrl = accessToken.startsWith("TEST-")
      ? preference.sandbox_init_point
      : preference.init_point;
    if (!preferenceResponse.ok || !preference.id || !checkoutUrl) {
      const error = new Error("Mercado Pago no pudo crear el pago.");
      error.details = preference;
      throw error;
    }
    await supabase(`/rest/v1/purchase_orders?id=eq.${encodeURIComponent(order.id)}`, {
      method: "PATCH",
      body: JSON.stringify({
        preference_id: preference.id,
        payment_url: checkoutUrl,
        payment_expires_at: expiresAt
      })
    });
    return sendJson(res, 200, { checkout_url: checkoutUrl });
  } catch (error) {
    if (orderId) {
      try {
        await rpc("cancel_purchase_order", { p_order_id: orderId });
      } catch (cancelError) {
        console.error("Could not release the reserved stock after checkout failure.", cancelError);
      }
    }
    return publicError(error, res);
  }
};
