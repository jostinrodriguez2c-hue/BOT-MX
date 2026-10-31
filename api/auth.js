const { body, getEnv, onlyMethod, publicError, sendJson, supabase } = require("../lib/api");

async function login(email, password, res) {
  const response = await fetch(`${getEnv("SUPABASE_URL").replace(/\/+$/, "")}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: {
      apikey: getEnv("SUPABASE_ANON_KEY"),
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ email, password })
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
}

async function register(email, password, res) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254
    || typeof password !== "string" || password.length < 12 || password.length > 128) {
    return sendJson(res, 400, { error: "Escribe un correo válido y una contraseña de al menos 12 caracteres." });
  }
  const [application] = await supabase(
    `/rest/v1/worker_applications?email=eq.${encodeURIComponent(email)}&status=eq.approved&select=email&limit=1`
  );
  if (!application) {
    return sendJson(res, 403, { error: "Necesitas una solicitud aprobada para crear una cuenta de trabajador." });
  }
  const [existing] = await supabase(
    `/rest/v1/worker_users?email=eq.${encodeURIComponent(email)}&select=user_id&limit=1`
  );
  if (existing) {
    return sendJson(res, 409, { error: "Ya existe una cuenta de trabajador con ese correo. Inicia sesión." });
  }

  const response = await fetch(`${getEnv("SUPABASE_URL").replace(/\/+$/, "")}/auth/v1/signup`, {
    method: "POST",
    headers: {
      apikey: getEnv("SUPABASE_ANON_KEY"),
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ email, password })
  });
  const result = await response.json();
  if (!response.ok || !result.user || !result.user.id) {
    return sendJson(res, 400, { error: "No se pudo crear la cuenta. Revisa el correo o intenta iniciar sesión." });
  }
  await supabase("/rest/v1/worker_users", {
    method: "POST",
    headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
    body: JSON.stringify({ user_id: result.user.id, email })
  });
  return sendJson(res, 201, {
    ok: true,
    confirmationRequired: !result.session,
    message: result.session
      ? "Cuenta creada. Ya puedes iniciar sesión."
      : "Cuenta creada. Confirma tu correo desde el mensaje de Supabase y luego inicia sesión."
  });
}

module.exports = async function handler(req, res) {
  if (!onlyMethod(req, res, "POST")) return;
  try {
    const payload = body(req);
    const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
    if (!email || typeof payload.password !== "string" || !payload.password) {
      return sendJson(res, 400, { error: "Escribe el correo y la contraseña de tu cuenta." });
    }
    if (payload.action === "register") return await register(email, payload.password, res);
    if (payload.action !== "login") {
      return sendJson(res, 400, { error: "Selecciona iniciar sesión o crear cuenta." });
    }
    return await login(email, payload.password, res);
  } catch (error) {
    return publicError(error, res);
  }
};
