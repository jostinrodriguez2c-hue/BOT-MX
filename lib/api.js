const crypto = require("node:crypto");

function getEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing server environment variable: ${name}`);
  return value;
}

function sendJson(res, status, body) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.status(status).json(body);
}

function onlyMethod(req, res, method) {
  if (req.method === method) return true;
  res.setHeader("Allow", method);
  sendJson(res, 405, { error: "Method not allowed." });
  return false;
}

function body(req) {
  const value = req.body;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("A JSON request body is required.");
  }
  return value;
}

function supabaseHeaders(extra = {}) {
  const key = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    ...extra
  };
}

async function supabase(path, options = {}) {
  const base = getEnv("SUPABASE_URL").replace(/\/+$/, "");
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: supabaseHeaders(options.headers || {})
  });
  const text = await response.text();
  let result;
  try {
    result = text ? JSON.parse(text) : null;
  } catch {
    throw new Error("Supabase returned an invalid response.");
  }
  if (!response.ok) {
    const error = new Error(result && (result.message || result.error_description) || "Supabase request failed.");
    error.status = response.status;
    error.details = result;
    throw error;
  }
  return result;
}

async function rpc(name, args) {
  return supabase(`/rest/v1/rpc/${name}`, {
    method: "POST",
    body: JSON.stringify(args)
  });
}

function otpHash(orderId, code) {
  return crypto.createHmac("sha256", getEnv("OTP_SECRET"))
    .update(`${orderId}:${code}`)
    .digest("hex");
}

function hashIp(ip) {
  const secret = process.env.OTP_SECRET || getEnv("SUPABASE_SERVICE_ROLE_KEY");
  return crypto.createHmac("sha256", secret)
    .update(ip || "unknown")
    .digest("hex");
}

function safeEqualHex(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || left.length !== right.length) return false;
  return crypto.timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function publicError(error, res) {
  const message = String(error.message || "");
  if (message.includes("otp_rate_limited")) {
    sendJson(res, 429, { error: "Demasiados intentos. Espera un minuto e inténtalo de nuevo." });
    return;
  }
  if (message.includes("demo_rate_limited")) {
    sendJson(res, 429, { error: "Se alcanzó el límite de compras de demostración. Inténtalo más tarde." });
    return;
  }
  if (message.includes("product_unavailable")) {
    sendJson(res, 409, { error: "El producto ya no tiene existencias suficientes." });
    return;
  }
  if (message.includes("product_price_missing")) {
    sendJson(res, 409, { error: "Este producto aún no tiene precio configurado." });
    return;
  }
  console.error("API request failed.", error);
  sendJson(res, error.status && error.status < 500 ? error.status : 500, {
    error: error.status && error.status < 500 ? "La solicitud no pudo completarse." : "Ocurrió un error del servidor. Inténtalo más tarde."
  });
}

async function requireAdmin(req) {
  const authorization = req.headers.authorization || "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!token) {
    const error = new Error("Authentication required.");
    error.status = 401;
    throw error;
  }
  const anonKey = getEnv("SUPABASE_ANON_KEY");
  const base = getEnv("SUPABASE_URL").replace(/\/+$/, "");
  const authResponse = await fetch(`${base}/auth/v1/user`, {
    headers: { apikey: anonKey, Authorization: `Bearer ${token}` }
  });
  if (!authResponse.ok) {
    const error = new Error("Invalid administrator session.");
    error.status = 401;
    throw error;
  }
  const user = await authResponse.json();
  if (typeof user.email !== "string" || user.email.toLowerCase() !== getEnv("ADMIN_EMAIL").trim().toLowerCase()) {
    const error = new Error("Administrator access is not enabled for this account.");
    error.status = 403;
    throw error;
  }
  const admins = await supabase(`/rest/v1/admin_users?user_id=eq.${encodeURIComponent(user.id)}&select=user_id&limit=1`);
  if (!Array.isArray(admins) || admins.length !== 1) {
    const error = new Error("Administrator access is not enabled for this account.");
    error.status = 403;
    throw error;
  }
  return user;
}

async function emailOtp(to, code) {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getEnv("RESEND_API_KEY")}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: getEnv("RESEND_FROM"),
      to: [to],
      subject: "Código para confirmar tu compra en Wilcox Company",
      text: `Tu código de confirmación es ${code}. Es de un solo uso y vence en 10 minutos. Si no solicitaste esta compra, ignora este correo.`
    })
  });
  if (!response.ok) {
    const details = await response.text();
    console.error("Resend email delivery failed.", response.status, details.slice(0, 500));
    throw new Error("No se pudo enviar el código de confirmación.");
  }
}

module.exports = {
  body,
  emailOtp,
  getEnv,
  hashIp,
  onlyMethod,
  otpHash,
  publicError,
  requireAdmin,
  rpc,
  safeEqualHex,
  sendJson,
  supabase
};
