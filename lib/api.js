const crypto = require("node:crypto");

const SUPER_ADMIN_OWNER_EMAIL = "jostin.rodriguez2c@gmail.com";
const SUPER_ADMIN_ROLE_NAME = "Administrador supremo";
const WORKER_PERMISSIONS = [
  "inventory_view",
  "sales_register",
  "products_manage",
  "workers_directory",
  "applications_review",
  "catalog_manage"
];

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

async function writeActivity(user, eventType, summary, details = {}, audience = "admin", recipientEmail = null) {
  const email = typeof user.email === "string" ? user.email.toLowerCase() : "";
  const metadata = user.user_metadata && typeof user.user_metadata === "object" ? user.user_metadata : {};
  const name = typeof metadata.full_name === "string" && metadata.full_name.trim()
    ? metadata.full_name.trim()
    : email;
  await supabase("/rest/v1/activity_events", {
    method: "POST",
    body: JSON.stringify({
      actor_user_id: user.id || null,
      actor_email: email,
      actor_name: name,
      event_type: eventType,
      summary,
      details,
      visibility: audience,
      recipient_email: recipientEmail
    })
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

function workerActivationCipherKey() {
  return crypto.createHash("sha256").update(getEnv("SUPABASE_SERVICE_ROLE_KEY")).digest();
}

function encryptWorkerActivationCode(code) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", workerActivationCipherKey(), iv);
  const encrypted = Buffer.concat([cipher.update(code, "utf8"), cipher.final()]);
  return `${iv.toString("hex")}.${cipher.getAuthTag().toString("hex")}.${encrypted.toString("hex")}`;
}

function decryptWorkerActivationCode(value) {
  const parts = typeof value === "string" ? value.split(".") : [];
  if (parts.length !== 3 || parts.some(part => !/^[a-f0-9]+$/i.test(part))) {
    throw new Error("Stored worker activation code is invalid.");
  }
  const [iv, authTag, encrypted] = parts.map(part => Buffer.from(part, "hex"));
  if (iv.length !== 12 || authTag.length !== 16 || encrypted.length !== 4) {
    throw new Error("Stored worker activation code has an invalid format.");
  }
  const decipher = crypto.createDecipheriv("aes-256-gcm", workerActivationCipherKey(), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

function safeEqualHex(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || left.length !== right.length) return false;
  return crypto.timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function publicError(error, res) {
  const message = String(error.message || "");
  const details = error.details && typeof error.details === "object" ? error.details : {};
  const databaseMessage = `${message} ${details.message || ""} ${details.details || ""}`.toLowerCase();
  if (
    details.code === "PGRST202"
    && databaseMessage.includes("register_demo_purchase")
  ) {
    sendJson(res, 503, {
      error: "Falta instalar en Supabase la función de compra simulada register_demo_purchase. Ejecuta el bloque actualizado de compras de demostración en supabase/schema.sql."
    });
    return;
  }
  if (
    ["PGRST205", "42P01"].includes(details.code)
    && databaseMessage.includes("purchase_rate_limits")
  ) {
    sendJson(res, 503, {
      error: "Falta la tabla purchase_rate_limits en Supabase. Ejecuta el esquema actualizado de compras de demostración."
    });
    return;
  }
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
  const email = typeof user.email === "string" ? user.email.toLowerCase() : "";
  const isOwner = email === SUPER_ADMIN_OWNER_EMAIL;
  if (email === getEnv("ADMIN_EMAIL").trim().toLowerCase() || isOwner) {
    const admins = await supabase(`/rest/v1/admin_users?user_id=eq.${encodeURIComponent(user.id)}&select=user_id&limit=1`);
    if (Array.isArray(admins) && admins.length === 1) {
      return {
        ...user,
        role: "admin",
        permissions: WORKER_PERMISSIONS,
        isSuperAdminManager: isOwner
      };
    }
  }
  const [worker] = await supabase(
    `/rest/v1/worker_users?user_id=eq.${encodeURIComponent(user.id)}&email=eq.${encodeURIComponent(email)}&select=user_id&limit=1`
  );
  const [application] = worker ? await supabase(
    `/rest/v1/worker_applications?email=eq.${encodeURIComponent(email)}&status=eq.approved&select=role_id&limit=1`
  ) : [];
  const [role] = application && application.role_id ? await supabase(
    `/rest/v1/worker_roles?id=eq.${encodeURIComponent(application.role_id)}&select=name&limit=1`
  ) : [];
  if (role && role.name === SUPER_ADMIN_ROLE_NAME) {
    return {
      ...user,
      role: "admin",
      permissions: WORKER_PERMISSIONS,
      isSuperAdminManager: false
    };
  }
  const error = new Error("Administrator access is not enabled for this account.");
  error.status = 403;
  throw error;
}

async function requireInventoryAccess(req) {
  const authorization = req.headers.authorization || "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!token) {
    const error = new Error("Authentication required.");
    error.status = 401;
    throw error;
  }
  const authResponse = await fetch(`${getEnv("SUPABASE_URL").replace(/\/+$/, "")}/auth/v1/user`, {
    headers: {
      apikey: getEnv("SUPABASE_ANON_KEY"),
      Authorization: `Bearer ${token}`
    }
  });
  if (!authResponse.ok) {
    const error = new Error("Invalid inventory session.");
    error.status = 401;
    throw error;
  }
  const user = await authResponse.json();
  const email = typeof user.email === "string" ? user.email.toLowerCase() : "";
  if (email === getEnv("ADMIN_EMAIL").trim().toLowerCase() || email === SUPER_ADMIN_OWNER_EMAIL) {
    const admins = await supabase(`/rest/v1/admin_users?user_id=eq.${encodeURIComponent(user.id)}&select=user_id&limit=1`);
    if (Array.isArray(admins) && admins.length === 1) {
      return {
        ...user,
        role: "admin",
        permissions: WORKER_PERMISSIONS,
        isSuperAdminManager: email === SUPER_ADMIN_OWNER_EMAIL
      };
    }
  }
  const workers = await supabase(
    `/rest/v1/worker_users?user_id=eq.${encodeURIComponent(user.id)}&email=eq.${encodeURIComponent(email)}&select=user_id&limit=1`
  );
  const [application] = workers.length ? await supabase(
    `/rest/v1/worker_applications?email=eq.${encodeURIComponent(email)}&status=eq.approved&select=email,role_id&limit=1`
  ) : [];
  if (workers.length === 1 && application) {
    let permissions = [];
    if (application.role_id) {
      const [assignedRole] = await supabase(
        `/rest/v1/worker_roles?id=eq.${encodeURIComponent(application.role_id)}&select=name,permissions&limit=1`
      );
      permissions = Array.isArray(assignedRole && assignedRole.permissions) ? assignedRole.permissions : [];
      if (assignedRole && assignedRole.name === SUPER_ADMIN_ROLE_NAME) {
        return {
          ...user,
          role: "admin",
          permissions: WORKER_PERMISSIONS,
          isSuperAdminManager: false
        };
      }
    }
    return { ...user, role: "worker", permissions, isSuperAdminManager: false };
  }
  const error = new Error("Inventory access is not enabled for this account.");
  error.status = 403;
  throw error;
}

async function requireWorkerPermission(req, permission) {
  const user = await requireInventoryAccess(req);
  if (user.role === "admin" || user.permissions.includes(permission)) return user;
  const error = new Error("Tu rol no tiene permiso para realizar esta acción.");
  error.status = 403;
  throw error;
}

async function requireAnyWorkerPermission(req, permissions) {
  const user = await requireInventoryAccess(req);
  if (user.role === "admin" || permissions.some(permission => user.permissions.includes(permission))) return user;
  const error = new Error("Tu rol no tiene permiso para realizar esta acción.");
  error.status = 403;
  throw error;
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
  decryptWorkerActivationCode,
  emailOtp,
  encryptWorkerActivationCode,
  getEnv,
  hashIp,
  onlyMethod,
  otpHash,
  publicError,
  requireAnyWorkerPermission,
  requireAdmin,
  requireInventoryAccess,
  requireWorkerPermission,
  rpc,
  safeEqualHex,
  sendJson,
  SUPER_ADMIN_OWNER_EMAIL,
  SUPER_ADMIN_ROLE_NAME,
  supabase,
  WORKER_PERMISSIONS,
  writeActivity
};
