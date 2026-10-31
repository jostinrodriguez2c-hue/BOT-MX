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

async function resendWorkerSignup(email, res) {
  let response;
  try {
    response = await fetch(`${getEnv("SUPABASE_URL").replace(/\/+$/, "")}/auth/v1/resend`, {
      method: "POST",
      headers: {
        apikey: getEnv("SUPABASE_ANON_KEY"),
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ type: "signup", email })
    });
  } catch (error) {
    console.error("No se pudo conectar con Supabase para reenviar la confirmación.", error.message);
    return sendJson(res, 502, {
      error: "No se pudo conectar para enviar el enlace. Inténtalo de nuevo en 30 segundos.",
      retryAfterSeconds: 30
    });
  }
  let result;
  try {
    result = await response.json();
  } catch {
    return sendJson(res, 502, {
      error: "Supabase devolvió una respuesta no válida. Inténtalo de nuevo en 30 segundos.",
      retryAfterSeconds: 30
    });
  }
  const providerError = `${result && (result.error_code || result.code) || ""} ${result && (result.msg || result.message || result.error_description) || ""}`.toLowerCase();
  if (!response.ok && /already confirmed|user is confirmed/.test(providerError)) {
    return sendJson(res, 200, {
      ok: true,
      retryAfterSeconds: 30,
      message: "Esta cuenta ya está confirmada. Inicia sesión con ese correo."
    });
  }
  if (!response.ok && /rate.?limit|email.*limit|too many requests/.test(providerError)) {
    res.setHeader("Retry-After", "30");
    return sendJson(res, 429, {
      error: "Espera 30 segundos antes de volver a solicitar el enlace con este correo.",
      retryAfterSeconds: 30
    });
  }
  if (!response.ok) {
    return sendJson(res, 502, {
      error: "No se pudo enviar el enlace de confirmación. Inténtalo de nuevo en 30 segundos.",
      retryAfterSeconds: 30
    });
  }
  return sendJson(res, 200, {
    ok: true,
    retryAfterSeconds: 30,
    message: "Si la cuenta aún necesita confirmarse, Supabase enviará un nuevo enlace. Si ya está confirmada, inicia sesión."
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
  const retryAfterSeconds = await supabase("/rest/v1/rpc/claim_worker_signup", {
    method: "POST",
    body: JSON.stringify({ p_email: email })
  });
  if (Number(retryAfterSeconds) > 0) {
    const seconds = Math.ceil(Number(retryAfterSeconds));
    res.setHeader("Retry-After", String(seconds));
    return sendJson(res, 429, {
      error: `Espera ${seconds} segundos antes de volver a intentarlo con este correo.`,
      retryAfterSeconds: seconds
    });
  }
  const [existing] = await supabase(
    `/rest/v1/worker_users?email=eq.${encodeURIComponent(email)}&select=user_id&limit=1`
  );
  if (existing) return await resendWorkerSignup(email, res);

  let response;
  try {
    response = await fetch(`${getEnv("SUPABASE_URL").replace(/\/+$/, "")}/auth/v1/signup`, {
      method: "POST",
      headers: {
        apikey: getEnv("SUPABASE_ANON_KEY"),
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ email, password })
    });
  } catch (error) {
    console.error("No se pudo conectar con Supabase para crear la cuenta.", error.message);
    return sendJson(res, 502, {
      error: "No se pudo conectar para crear la cuenta. Inténtalo de nuevo en 30 segundos.",
      retryAfterSeconds: 30
    });
  }
  let result;
  try {
    result = await response.json();
  } catch {
    return sendJson(res, 502, {
      error: "Supabase devolvió una respuesta no válida. Inténtalo de nuevo en 30 segundos.",
      retryAfterSeconds: 30
    });
  }
  const authResult = result && typeof result === "object" ? result : {};
  if (authResult.user && Array.isArray(authResult.user.identities) && authResult.user.identities.length === 0) {
    return await resendWorkerSignup(email, res);
  }
  if (!response.ok || !authResult.user || !authResult.user.id) {
    const providerError = `${authResult.error_code || authResult.code || ""} ${authResult.msg || authResult.message || authResult.error_description || ""}`.toLowerCase();
    if (/rate.?limit|email.*limit|too many requests/.test(providerError)) {
      res.setHeader("Retry-After", "30");
      return sendJson(res, 429, {
        error: "Espera 30 segundos antes de volver a intentarlo con este correo.",
        retryAfterSeconds: 30
      });
    }
    if (/password|weak/.test(providerError)) {
      return sendJson(res, 400, {
        error: "Supabase rechazó la contraseña. Usa una contraseña más segura de al menos 12 caracteres.",
        retryAfterSeconds: 30
      });
    }
    if (/already registered|already exists|email_exists|user_already_exists/.test(providerError)) {
      return await resendWorkerSignup(email, res);
    }
    if (/signup.*disabled|signups not allowed/.test(providerError)) {
      return sendJson(res, 503, { error: "La creación de cuentas está desactivada en Supabase. Contacta al administrador." });
    }
    return sendJson(res, response.ok ? 502 : response.status, {
      error: "Supabase no pudo crear la cuenta. Verifica el correo y la contraseña e inténtalo de nuevo.",
      retryAfterSeconds: 30
    });
  }
  let workerProfileSaved = true;
  try {
    await supabase("/rest/v1/worker_users", {
      method: "POST",
      headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
      body: JSON.stringify({ user_id: authResult.user.id, email, name: application.name || "" })
    });
  } catch (error) {
    workerProfileSaved = false;
    console.error("No se pudo vincular la cuenta creada con worker_users.", error.message);
  }
  try {
    await writeActivity(
      { id: authResult.user.id, email, user_metadata: { full_name: application.name || "" } },
      "worker_registration",
      "Creó su cuenta de trabajador"
    );
  } catch (error) {
    console.error("No se pudo registrar la actividad de creación de cuenta.", error.message);
  }
  return sendJson(res, 201, {
    ok: true,
    retryAfterSeconds: 30,
    confirmationRequired: !authResult.session,
    message: !workerProfileSaved
      ? "Tu cuenta se creó, pero no se pudo completar el registro interno. Confirma tu correo e intenta iniciar sesión; si no puedes, contacta al administrador."
      : authResult.session
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
      ["PGRST202", "PGRST205", "42P01", "42703"].includes(details.code)
      && ["worker_signup_attempts", "claim_worker_signup"].some(name => databaseMessage.includes(name))
    ) {
      return sendJson(res, 503, {
        error: "Falta instalar el control de registro en Supabase. Ejecuta el archivo supabase/schema.sql completo en SQL Editor y vuelve a intentarlo."
      });
    }
    if (
      ["PGRST202", "PGRST204", "PGRST205", "42P01", "42703"].includes(details.code)
      && ["worker_applications", "worker_users", "worker_roles", "activity_events", "worker_signup_attempts", "claim_worker_signup"].some(table => databaseMessage.includes(table))
    ) {
      return sendJson(res, 503, {
        error: "Falta actualizar las tablas de trabajadores en Supabase. Ejecuta el archivo supabase/schema.sql completo y vuelve a intentarlo."
      });
    }
    return publicError(error, res);
  }
};
