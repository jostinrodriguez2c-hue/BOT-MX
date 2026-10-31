const { body, getEnv, onlyMethod, publicError, sendJson, supabase } = require("../lib/api");

module.exports = async function handler(req, res) {
  if (!onlyMethod(req, res, "POST")) return;
  try {
    const { email, password } = body(req);
    if (typeof email !== "string" || typeof password !== "string" || !email.trim() || !password) {
      return sendJson(res, 400, { error: "Escribe el correo y la contraseña de administrador." });
    }
    const response = await fetch(`${getEnv("SUPABASE_URL").replace(/\/+$/, "")}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: {
        apikey: getEnv("SUPABASE_ANON_KEY"),
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ email: email.trim(), password })
    });
    const session = await response.json();
    if (!response.ok || !session.access_token || !session.user) {
      return sendJson(res, 401, { error: "Correo o contraseña incorrectos." });
    }
    if (session.user.email.toLowerCase() !== getEnv("ADMIN_EMAIL").trim().toLowerCase()) {
      return sendJson(res, 403, { error: "Esta cuenta no tiene permisos de administrador." });
    }
    const admins = await supabase(`/rest/v1/admin_users?user_id=eq.${encodeURIComponent(session.user.id)}&select=user_id&limit=1`);
    if (!admins.length) {
      return sendJson(res, 403, { error: "Esta cuenta no tiene permisos de administrador." });
    }
    return sendJson(res, 200, {
      access_token: session.access_token,
      refresh_token: session.refresh_token,
      expires_in: session.expires_in,
      user: { email: session.user.email }
    });
  } catch (error) {
    return publicError(error, res);
  }
};
