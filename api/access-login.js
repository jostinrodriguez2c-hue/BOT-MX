const { body, getEnv, onlyMethod, publicError, sendJson, supabase } = require("../lib/api");

module.exports = async function handler(req, res) {
  if (!onlyMethod(req, res, "POST")) return;
  try {
    const payload = body(req);
    const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
    if (!email || typeof payload.password !== "string" || !payload.password) {
      return sendJson(res, 400, { error: "Escribe el correo y la contraseña de tu cuenta." });
    }
    const response = await fetch(`${getEnv("SUPABASE_URL").replace(/\/+$/, "")}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: {
        apikey: getEnv("SUPABASE_ANON_KEY"),
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ email, password: payload.password })
    });
    const session = await response.json();
    if (!response.ok || !session.access_token || !session.user) {
      return sendJson(res, 401, { error: "Correo o contraseña incorrectos." });
    }
    const userEmail = typeof session.user.email === "string" ? session.user.email.toLowerCase() : "";
    if (userEmail === getEnv("ADMIN_EMAIL").trim().toLowerCase()) {
      const admins = await supabase(
        `/rest/v1/admin_users?user_id=eq.${encodeURIComponent(session.user.id)}&select=user_id&limit=1`
      );
      if (admins.length !== 1) {
        return sendJson(res, 403, { error: "Esta cuenta no tiene permisos de administrador." });
      }
      return sendJson(res, 200, {
        access_token: session.access_token,
        expires_in: session.expires_in,
        user: { email: userEmail, role: "admin" }
      });
    }
    const [worker] = await supabase(
      `/rest/v1/worker_users?user_id=eq.${encodeURIComponent(session.user.id)}&email=eq.${encodeURIComponent(userEmail)}&select=user_id&limit=1`
    );
    const [application] = worker ? await supabase(
      `/rest/v1/worker_applications?email=eq.${encodeURIComponent(userEmail)}&status=eq.approved&select=email&limit=1`
    ) : [];
    if (!worker || !application) {
      return sendJson(res, 403, { error: "Esta cuenta no tiene acceso de trabajador aprobado." });
    }
    return sendJson(res, 200, {
      access_token: session.access_token,
      expires_in: session.expires_in,
      user: { email: userEmail, role: "worker" }
    });
  } catch (error) {
    return publicError(error, res);
  }
};
