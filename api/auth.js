const {
  body,
  getEnv,
  onlyMethod,
  publicError,
  requireInventoryAccess,
  sendJson,
  supabase,
  writeActivity
} = require("../lib/api");

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
    await writeActivity(session.user, "admin_login", "Inicio de sesión de administrador");
    return sendJson(res, 200, {
      access_token: session.access_token,
      expires_in: session.expires_in,
      user: { email: userEmail, role: "admin" }
    });
  }

  const [application] = await supabase(
    `/rest/v1/worker_applications?email=eq.${encodeURIComponent(userEmail)}&status=eq.approved&select=email,name,role_id&limit=1`
  );
  if (!application) {
    return sendJson(res, 403, { error: "Esta cuenta no tiene acceso de trabajador aprobado." });
  }
  const [worker] = await supabase(
    `/rest/v1/worker_users?user_id=eq.${encodeURIComponent(session.user.id)}&email=eq.${encodeURIComponent(userEmail)}&select=user_id&limit=1`
  );
  if (!worker) {
    const [existingEmailAccount] = await supabase(
      `/rest/v1/worker_users?email=eq.${encodeURIComponent(userEmail)}&select=user_id&limit=1`
    );
    if (existingEmailAccount && existingEmailAccount.user_id !== session.user.id) {
      return sendJson(res, 403, { error: "Este correo está asociado a otra cuenta de trabajador. Contacta al administrador." });
    }
    await supabase("/rest/v1/worker_users", {
      method: "POST",
      headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
      body: JSON.stringify({
        user_id: session.user.id,
        email: userEmail,
        name: application.name || ""
      })
    });
  }
  const [role] = application.role_id ? await supabase(
    `/rest/v1/worker_roles?id=eq.${encodeURIComponent(application.role_id)}&select=permissions&limit=1`
  ) : [];
  const permissions = Array.isArray(role && role.permissions) ? role.permissions : [];
  await writeActivity(session.user, "worker_login", "Inicio de sesión de trabajador");
  return sendJson(res, 200, {
    access_token: session.access_token,
    expires_in: session.expires_in,
    user: { email: userEmail, role: "worker", permissions }
  });
}

async function register(email, password, res) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254
    || typeof password !== "string" || password.length < 12 || password.length > 128) {
    return sendJson(res, 400, { error: "Escribe un correo válido y una contraseña de al menos 12 caracteres." });
  }
  const [application] = await supabase(
    `/rest/v1/worker_applications?email=eq.${encodeURIComponent(email)}&status=eq.approved&select=email,name&limit=1`
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
  if (Array.isArray(result.user.identities) && result.user.identities.length === 0) {
    return sendJson(res, 409, {
      error: "Ya existe una cuenta con ese correo. Inicia sesión; si acabas de registrarte, confirma primero tu correo."
    });
  }
  await supabase("/rest/v1/worker_users", {
    method: "POST",
    headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
    body: JSON.stringify({ user_id: result.user.id, email, name: application.name || "" })
  });
  await writeActivity(
    { id: result.user.id, email, user_metadata: { full_name: application.name || "" } },
    "worker_registration",
    "Creó su cuenta de trabajador"
  );
  return sendJson(res, 201, {
    ok: true,
    confirmationRequired: !result.session,
    message: result.session
      ? "Cuenta creada. Ya puedes iniciar sesión."
      : "Cuenta creada. Confirma tu correo desde el mensaje de Supabase y luego inicia sesión."
  });
}

async function updateWorkerPassword(recoveryToken, password, res) {
  if (typeof recoveryToken !== "string" || recoveryToken.length < 20 || recoveryToken.length > 4096
    || typeof password !== "string" || password.length < 12 || password.length > 128) {
    return sendJson(res, 400, { error: "El enlace no es válido o la contraseña tiene menos de 12 caracteres." });
  }
  const base = getEnv("SUPABASE_URL").replace(/\/+$/, "");
  const headers = {
    apikey: getEnv("SUPABASE_ANON_KEY"),
    Authorization: `Bearer ${recoveryToken}`,
    "Content-Type": "application/json"
  };
  const userResponse = await fetch(`${base}/auth/v1/user`, { headers });
  if (!userResponse.ok) {
    return sendJson(res, 401, { error: "El enlace venció o ya se utilizó. Solicita uno nuevo al administrador." });
  }
  const user = await userResponse.json();
  const email = typeof user.email === "string" ? user.email.toLowerCase() : "";
  const [worker] = await supabase(
    `/rest/v1/worker_users?user_id=eq.${encodeURIComponent(user.id)}&email=eq.${encodeURIComponent(email)}&select=user_id&limit=1`
  );
  const [application] = worker ? await supabase(
    `/rest/v1/worker_applications?email=eq.${encodeURIComponent(email)}&status=eq.approved&select=email&limit=1`
  ) : [];
  if (!worker || !application) {
    return sendJson(res, 403, { error: "Este enlace no corresponde a una cuenta de trabajador activa." });
  }
  const updateResponse = await fetch(`${base}/auth/v1/user`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ password })
  });
  if (!updateResponse.ok) {
    return sendJson(res, 400, { error: "No se pudo actualizar la contraseña. Solicita un enlace nuevo." });
  }
  return sendJson(res, 200, { ok: true, message: "Contraseña actualizada. Ya puedes iniciar sesión." });
}

module.exports = async function handler(req, res) {
  if (req.method === "GET") {
    try {
      const user = await requireInventoryAccess(req);
      return sendJson(res, 200, {
        user: {
          email: user.email,
          role: user.role,
          permissions: user.permissions || []
        }
      });
    } catch (error) {
      return publicError(error, res);
    }
  }
  if (!onlyMethod(req, res, "POST")) return;
  try {
    const payload = body(req);
    if (payload.action === "update_password") {
      return await updateWorkerPassword(payload.recoveryToken, payload.password, res);
    }
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
    const details = error.details && typeof error.details === "object" ? error.details : {};
    const databaseMessage = `${error.message || ""} ${details.message || ""} ${details.details || ""}`.toLowerCase();
    if (
      ["PGRST204", "PGRST205", "42P01", "42703"].includes(details.code)
      && ["worker_applications", "worker_users", "worker_roles", "activity_events"].some(table => databaseMessage.includes(table))
    ) {
      return sendJson(res, 503, {
        error: "Falta actualizar las tablas de trabajadores en Supabase. Ejecuta el archivo supabase/schema.sql completo y vuelve a intentarlo."
      });
    }
    return publicError(error, res);
  }
};
