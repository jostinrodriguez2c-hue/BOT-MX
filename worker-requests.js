const { body, getEnv, publicError, requireAdmin, requireInventoryAccess, sendJson, supabase, writeActivity } = require("../lib/api");

function normalizeEmail(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

module.exports = async function handler(req, res) {
  if (!["GET", "POST", "PATCH"].includes(req.method)) {
    res.setHeader("Allow", "GET, POST, PATCH");
    return sendJson(res, 405, { error: "Method not allowed." });
  }
  try {
    if (req.method === "GET") {
      if (req.query && req.query.view === "directory") {
        const user = await requireInventoryAccess(req);
        if (user.role !== "worker") {
          return sendJson(res, 403, { error: "Esta sección está disponible solo para trabajadores." });
        }
        const applications = await supabase(
          "/rest/v1/worker_applications?select=name,status,created_at,reviewed_at,department,position,company&status=eq.approved&order=name.asc"
        );
        const workers = applications.map(({ name, created_at, reviewed_at, department, position, company }) => ({
          name,
          department,
          position,
          company,
          started_at: reviewed_at || created_at
        }));
        return sendJson(res, 200, {
          workers,
          departments: [...new Set(workers.map(worker => worker.department).filter(Boolean))].sort(),
          positions: [...new Set(workers.map(worker => worker.position).filter(Boolean))].sort(),
          companies: [...new Set(workers.map(worker => worker.company).filter(Boolean))].sort()
        });
      }
      await requireAdmin(req);
      if (req.query && req.query.view === "workers") {
        const [applications, accounts, warnings] = await Promise.all([
          supabase("/rest/v1/worker_applications?select=email,name,status,created_at,reviewed_at,department,position,company&status=eq.approved&order=created_at.desc"),
          supabase("/rest/v1/worker_users?select=email,user_id,name"),
          supabase("/rest/v1/worker_warnings?select=email,message,created_at&order=created_at.desc")
        ]);
        const workers = applications.map(application => ({
          ...application,
          accountCreated: accounts.some(account => account.email === application.email),
          warnings: warnings.filter(warning => warning.email === application.email)
        }));
        return sendJson(res, 200, { workers });
      }
      const requests = await supabase(
        "/rest/v1/worker_applications?select=email,name,status,created_at,reviewed_at&order=created_at.desc"
      );
      return sendJson(res, 200, { requests });
    }

    const payload = body(req);
    const email = normalizeEmail(payload.email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      return sendJson(res, 400, { error: "Escribe un correo electrónico válido." });
    }

    if (req.method === "POST") {
      const name = typeof payload.name === "string" ? payload.name.trim() : "";
      if (!name || name.length > 120) {
        return sendJson(res, 400, { error: "Escribe tu nombre (máximo 120 caracteres)." });
      }
      const [existing] = await supabase(
        `/rest/v1/worker_applications?email=eq.${encodeURIComponent(email)}&select=status&limit=1`
      );
      if (existing && existing.status === "approved") {
        return sendJson(res, 409, { error: "Esta solicitud ya fue aprobada. Crea tu cuenta en la sección Trabajador." });
      }
      if (existing && existing.status === "terminated") {
        return sendJson(res, 409, { error: "Esta solicitud fue cerrada por el administrador." });
      }
      if (existing && existing.status === "pending") {
        await supabase(`/rest/v1/worker_applications?email=eq.${encodeURIComponent(email)}`, {
          method: "PATCH",
          body: JSON.stringify({ name })
        });
        return sendJson(res, 200, { ok: true, message: "La solicitud ya está pendiente de revisión." });
      }
      await supabase("/rest/v1/worker_applications", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({
          email,
          name,
          status: "pending",
          created_at: new Date().toISOString(),
          reviewed_at: null,
          reviewed_by: null
        })
      });
      return sendJson(res, 201, { ok: true, message: "Solicitud enviada para revisión." });
    }

    const admin = await requireAdmin(req);
    const action = payload.action;
    if (!["approve", "reject", "warn", "dismiss", "update_profile", "reset_password"].includes(action)) {
      return sendJson(res, 400, { error: "Selecciona una acción válida para la solicitud." });
    }
    const [request] = await supabase(
      `/rest/v1/worker_applications?email=eq.${encodeURIComponent(email)}&select=email,name,status,department,position,company&limit=1`
    );
    if (!request) return sendJson(res, 404, { error: "No se encontró la solicitud." });
    if (action === "update_profile") {
      if (request.status !== "approved") {
        return sendJson(res, 409, { error: "Solo se pueden actualizar los datos de trabajadores aprobados." });
      }
      const department = typeof payload.department === "string" ? payload.department.trim() : "";
      const position = typeof payload.position === "string" ? payload.position.trim() : "";
      const company = typeof payload.company === "string" ? payload.company.trim() : "";
      if (department.length > 80 || position.length > 80 || company.length > 120) {
        return sendJson(res, 400, { error: "El departamento y cargo admiten hasta 80 caracteres; la empresa, 120." });
      }
      const rows = await supabase(
        `/rest/v1/worker_applications?email=eq.${encodeURIComponent(email)}&status=eq.approved`,
        {
          method: "PATCH",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify({ department, position, company })
        }
      );
      if (!rows.length) return sendJson(res, 409, { error: "El trabajador ya no está activo." });
      await writeActivity(admin, "worker_profile_update", "Actualizó datos de un trabajador", {
        email,
        department,
        position,
        company
      });
      return sendJson(res, 200, { ok: true });
    }
    if (action === "reset_password") {
      if (request.status !== "approved") {
        return sendJson(res, 409, { error: "Solo se puede restablecer la cuenta de un trabajador aprobado." });
      }
      const [account] = await supabase(
        `/rest/v1/worker_users?email=eq.${encodeURIComponent(email)}&select=user_id&limit=1`
      );
      if (!account) return sendJson(res, 409, { error: "Este trabajador todavía no ha creado una cuenta." });
      const base = getEnv("SUPABASE_URL").replace(/\/+$/, "");
      const recoveryResponse = await fetch(`${base}/auth/v1/recover`, {
        method: "POST",
        headers: {
          apikey: getEnv("SUPABASE_ANON_KEY"),
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ email })
      });
      if (!recoveryResponse.ok) {
        throw new Error("Supabase no pudo enviar el enlace. Revisa la configuración de correo y URL de Auth.");
      }
      await writeActivity(admin, "worker_password_recovery", "Envió un enlace de restablecimiento", { email });
      return sendJson(res, 200, {
        ok: true,
        message: "Se envió un enlace de restablecimiento al correo del trabajador."
      });
    }
    if (action === "warn" || action === "dismiss") {
      if (request.status !== "approved") {
        return sendJson(res, 409, { error: "Solo se pueden administrar trabajadores aprobados." });
      }
      if (action === "warn") {
        const message = typeof payload.message === "string" ? payload.message.trim() : "";
        if (!message || message.length > 500) {
          return sendJson(res, 400, { error: "Escribe el motivo de la advertencia (máximo 500 caracteres)." });
        }
        await supabase("/rest/v1/worker_warnings", {
          method: "POST",
          body: JSON.stringify({ email, message, created_by: admin.id })
        });
        await writeActivity(
          admin,
          "worker_warning",
          "Advertencia para trabajador",
          { email, message },
          "worker",
          email
        );
        return sendJson(res, 201, { ok: true, action: "warn" });
      }
      const dismissed = await supabase(`/rest/v1/worker_applications?email=eq.${encodeURIComponent(email)}&status=eq.approved`, {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({
          status: "terminated",
          reviewed_at: new Date().toISOString(),
          reviewed_by: admin.id
        })
      });
      if (!dismissed.length) return sendJson(res, 409, { error: "El trabajador ya no está activo." });
      await writeActivity(admin, "worker_dismissal", "Despidió a un trabajador", { email });
      return sendJson(res, 200, { ok: true, action: "dismiss" });
    }
    if (request.status !== "pending") {
      return sendJson(res, 409, { error: "Solo se pueden aprobar o rechazar solicitudes pendientes." });
    }
    const rows = await supabase(`/rest/v1/worker_applications?email=eq.${encodeURIComponent(email)}&select=email,status`, {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        status: action === "approve" ? "approved" : "rejected",
        reviewed_at: new Date().toISOString(),
        reviewed_by: admin.id
      })
    });
    if (!rows.length) return sendJson(res, 404, { error: "No se encontró la solicitud." });
    await writeActivity(
      admin,
      action === "approve" ? "worker_approval" : "worker_rejection",
      action === "approve" ? "Aprobó a un trabajador" : "Rechazó una solicitud de trabajador",
      { email, name: request.name || "" }
    );
    return sendJson(res, 200, { ok: true, status: rows[0].status });
  } catch (error) {
    const details = error.details && typeof error.details === "object" ? error.details : {};
    const databaseMessage = `${error.message || ""} ${details.message || ""} ${details.details || ""}`.toLowerCase();
    if (
      ["PGRST204", "PGRST205", "42P01", "42703"].includes(details.code)
      && ["worker_applications", "worker_users", "worker_warnings", "activity_events"].some(table => databaseMessage.includes(table))
    ) {
      return sendJson(res, 503, {
        error: "Falta actualizar las tablas de trabajadores en Supabase. Ejecuta el archivo supabase/schema.sql completo y vuelve a intentarlo."
      });
    }
    return publicError(error, res);
  }
};
