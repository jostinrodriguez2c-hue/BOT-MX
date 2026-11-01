const crypto = require("node:crypto");
const {
  body,
  getEnv,
  onlyMethod,
  publicError,
  requireInventoryAccess,
  rpc,
  sendJson,
  SUPER_ADMIN_OWNER_EMAIL,
  SUPER_ADMIN_ROLE_NAME,
  supabase,
  WORKER_PERMISSIONS,
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
  if (userEmail === getEnv("ADMIN_EMAIL").trim().toLowerCase() || userEmail === SUPER_ADMIN_OWNER_EMAIL) {
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
      user: {
        email: userEmail,
        role: "admin",
        permissions: WORKER_PERMISSIONS,
        isSuperAdminManager: userEmail === SUPER_ADMIN_OWNER_EMAIL
      }
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
    `/rest/v1/worker_roles?id=eq.${encodeURIComponent(application.role_id)}&select=name,permissions&limit=1`
  ) : [];
  const permissions = Array.isArray(role && role.permissions) ? role.permissions : [];
  const isSupremeAdmin = Boolean(role && role.name === SUPER_ADMIN_ROLE_NAME);
  await writeActivity(session.user, "worker_login", "Inicio de sesión de trabajador");
  return sendJson(res, 200, {
    access_token: session.access_token,
    expires_in: session.expires_in,
    user: {
      email: userEmail,
      role: isSupremeAdmin ? "admin" : "worker",
      permissions: isSupremeAdmin ? WORKER_PERMISSIONS : permissions,
      isSuperAdminManager: false
    }
  });
}

async function activateWorker(email, code, password, res) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254
    || typeof code !== "string" || !/^\d{4}$/.test(code)
    || typeof password !== "string" || password.length < 6 || password.length > 128) {
    return sendJson(res, 400, { error: "Escribe un correo válido, el código temporal de 4 dígitos y una contraseña de al menos 6 caracteres." });
  }
  const [application] = await supabase(
    `/rest/v1/worker_applications?email=eq.${encodeURIComponent(email)}&status=eq.approved&select=email,name&limit=1`
  );
  if (!application) {
    return sendJson(res, 403, { error: "No hay una solicitud aprobada para ese correo." });
  }
  const [existing] = await supabase(
    `/rest/v1/worker_users?email=eq.${encodeURIComponent(email)}&select=user_id&limit=1`
  );
  if (existing) {
    return sendJson(res, 409, { error: "Ese correo ya tiene una cuenta. Inicia sesión o pide al administrador que restablezca tu acceso." });
  }
  const codeHash = crypto.createHmac("sha256", getEnv("SUPABASE_SERVICE_ROLE_KEY"))
    .update(code.toLowerCase())
    .digest("hex");
  const claimed = await rpc("consume_worker_activation_code", {
    p_email: email,
    p_code_hash: codeHash
  });
  if (claimed !== true) {
    return sendJson(res, 400, { error: "El código no es válido, venció o alcanzó el límite de intentos. Pide al administrador que genere otro." });
  }

  const serviceRoleKey = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  let authResponse;
  try {
    authResponse = await fetch(`${getEnv("SUPABASE_URL").replace(/\/+$/, "")}/auth/v1/admin/users`, {
      method: "POST",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `******`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        email,
        password,
        email_confirm: true,
        user_metadata: { full_name: application.name || "" }
      })
    });
  } catch (error) {
    console.error("No se pudo conectar con Supabase para activar la cuenta.", error.message);
    return sendJson(res, 502, { error: "No se pudo conectar con Supabase. El código no se consumió y puedes volver a intentarlo. Si continúa, el administrador debe revisar los registros de Vercel y Supabase; generar otro código no solucionará este error." });
  }
  let authResult;
  try {
    authResult = await authResponse.json();
  } catch {
    console.error("Supabase devolvió una respuesta no válida al crear la cuenta.", { status: authResponse.status });
    return sendJson(res, 502, { error: "Supabase devolvió una respuesta no válida. El código no se consumió; inténtalo otra vez y, si persiste, pide al administrador que revise los registros de Vercel y Supabase." });
  }
  const authUser = authResult && authResult.user ? authResult.user : authResult;
  if (!authResponse.ok || !authUser || !authUser.id) {
    const providerMessage = [
      authResult && authResult.msg,
      authResult && authResult.message,
      authResult && authResult.error_description,
      authResult && authResult.error
    ].filter(value => typeof value === "string").join(" ").toLowerCase();
    const rawProviderCode = String(authResult && (authResult.code || authResult.error_code) || "unknown");
    const providerCode = /^[a-z0-9_]{1,60}$/i.test(rawProviderCode) ? rawProviderCode : "unknown";
    console.error("Supabase admin user creation failed.", {
      status: authResponse.status,
      code: providerCode
    });
    if (/already registered|already exists|email_exists|user_already_exists/.test(`${providerMessage} ${providerCode.toLowerCase()}`)) {
      return sendJson(res, 409, { error: "Supabase ya tiene una cuenta anterior con ese correo. El administrador debe revisar Authentication → Users y, si es una cuenta pendiente que ya no se usa, eliminarla antes de generar otro código." });
    }
    if (/password|weak/.test(providerMessage) || /password|weak/i.test(providerCode)) {
      return sendJson(res, 400, { error: "Supabase rechazó la contraseña. Usa una contraseña de al menos 6 caracteres que cumpla la política de Authentication → Settings. El código sigue vigente; no necesitas pedir otro por este error." });
    }
    if (authResponse.status === 401 || authResponse.status === 403) {
      return sendJson(res, 503, { error: "Supabase rechazó la clave de servicio del servidor. El administrador debe revisar SUPABASE_SERVICE_ROLE_KEY en las variables de Vercel y volver a desplegar. No pidas otro código todavía." });
    }
    if (authResponse.status === 429) {
      return sendJson(res, 429, { error: "Supabase está limitando temporalmente la creación de cuentas. Espera unos minutos e inténtalo de nuevo con el mismo código." });
    }
    if (authResponse.status >= 500 || /database error|internal server error/.test(providerMessage)) {
      return sendJson(res, 502, { error: "Supabase no pudo guardar la cuenta. El código sigue vigente; no solicites otro todavía. El administrador debe revisar los registros de Authentication en Supabase y los registros de la función /api/auth en Vercel." });
    }
    return sendJson(res, 502, { error: `Supabase rechazó la creación de la cuenta (HTTP ${authResponse.status}, código ${providerCode}). El código no se consumió. Reinténtalo; si vuelve a fallar, el administrador debe revisar los registros de Authentication en Supabase y la función /api/auth en Vercel.` });
  }
  try {
    await supabase("/rest/v1/worker_users", {
      method: "POST",
      headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
      body: JSON.stringify({ user_id: authUser.id, email, name: application.name || "" })
    });
  } catch (error) {
    console.error("No se pudo vincular la cuenta activada con worker_users.", error.message);
    try {
      const cleanupResponse = await fetch(`${getEnv("SUPABASE_URL").replace(/\/+$/, "")}/auth/v1/admin/users/${encodeURIComponent(authUser.id)}`, {
        method: "DELETE",
        headers: { apikey: serviceRoleKey, Authorization: `******` }
      });
      if (!cleanupResponse.ok && cleanupResponse.status !== 404) {
        console.error("No se pudo limpiar la cuenta de Auth incompleta.", cleanupResponse.status);
      }
    } catch (cleanupError) {
      console.error("No se pudo limpiar la cuenta de Auth incompleta.", cleanupError.message);
    }
    return sendJson(res, 503, { error: "No se pudo completar la activación del trabajador. Pide al administrador que genere un código nuevo." });
  }
  try {
    await writeActivity(
      { id: authUser.id, email, user_metadata: { full_name: application.name || "" } },
      "worker_activation",
      "Activó su cuenta de trabajador"
    );
  } catch (error) {
    console.error("No se pudo registrar la actividad de activación de cuenta.", error.message);
  }
  return sendJson(res, 201, {
    ok: true,
    message: "Acceso activado. Ahora inicia sesión con tu correo y la contraseña que acabas de elegir."
  });
}

async function updateWorkerPassword(recoveryToken, password, res) {
  if (typeof recoveryToken !== "string" || recoveryToken.length < 20 || recoveryToken.length > 4096
    || typeof password !== "string" || password.length < 5 || password.length > 128) {
    return sendJson(res, 400, { error: "El enlace no es válido o la contraseña tiene menos de 5 caracteres." });
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
          permissions: user.permissions || [],
          isSuperAdminManager: Boolean(user.isSuperAdminManager)
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
    if (payload.action === "activate_worker") {
      return await activateWorker(email, payload.code, payload.password, res);
    }
    if (payload.action !== "login") {
      return sendJson(res, 400, { error: "Selecciona iniciar sesión o activar tu acceso." });
    }
    return await login(email, payload.password, res);
  } catch (error) {
    const details = error.details && typeof error.details === "object" ? error.details : {};
    const databaseMessage = `${error.message || ""} ${details.message || ""} ${details.details || ""}`.toLowerCase();
    if (
      ["PGRST202", "PGRST204", "PGRST205", "42P01", "42703"].includes(details.code)
      && (
        ["worker_applications", "worker_users", "worker_roles", "activity_events"].some(table => databaseMessage.includes(table))
        || databaseMessage.includes("consume_worker_activation_code")
      )
    ) {
      return sendJson(res, 503, {
        error: "Falta actualizar el esquema de trabajadores en Supabase. Ejecuta el archivo supabase/schema.sql actualizado completo y vuelve a intentarlo."
      });
    }
    return publicError(error, res);
  }
};
