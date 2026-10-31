const {
  body,
  getEnv,
  publicError,
  requireAdmin,
  requireInventoryAccess,
  requireWorkerPermission,
  sendJson,
  supabase,
  writeActivity
} = require("../lib/api");

const WORKER_PERMISSIONS = new Set([
  "inventory_view",
  "sales_register",
  "products_manage",
  "workers_directory",
  "applications_review",
  "catalog_manage"
]);

function normalizePermissions(value) {
  if (!Array.isArray(value) || value.some(permission => !WORKER_PERMISSIONS.has(permission))) return null;
  return [...new Set(value)];
}

function normalizeEmail(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

async function deleteWorkerAuthAccount(email) {
  const [account] = await supabase(
    `/rest/v1/worker_users?email=eq.${encodeURIComponent(email)}&select=user_id&limit=1`
  );
  if (!account) return;

  const serviceRoleKey = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  const response = await fetch(
    `${getEnv("SUPABASE_URL").replace(/\/+$/, "")}/auth/v1/admin/users/${encodeURIComponent(account.user_id)}`,
    {
      method: "DELETE",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`
      }
    }
  );
  if (!response.ok && response.status !== 404) {
    throw new Error("No se pudo eliminar la cuenta anterior de Supabase. Inténtalo otra vez antes de permitir un nuevo registro.");
  }
}

module.exports = async function handler(req, res) {
  if (!["GET", "POST", "PATCH", "DELETE"].includes(req.method)) {
    res.setHeader("Allow", "GET, POST, PATCH, DELETE");
    return sendJson(res, 405, { error: "Method not allowed." });
  }
  try {
    if (req.method === "GET") {
      if (req.query && req.query.view === "directory") {
        await requireWorkerPermission(req, "workers_directory");
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
      if (req.query && req.query.view === "admin_data") {
        await requireAdmin(req);
        const [catalogs, roles] = await Promise.all([
          supabase("/rest/v1/organization_catalogs?select=id,kind,name,description&order=kind.asc,name.asc"),
          supabase("/rest/v1/worker_roles?select=id,name,permissions&order=name.asc")
        ]);
        return sendJson(res, 200, { catalogs, roles });
      }
      if (req.query && req.query.view === "requests") {
        await requireWorkerPermission(req, "applications_review");
        const requests = await supabase(
          "/rest/v1/worker_applications?select=email,name,status,created_at,reviewed_at&order=created_at.desc"
        );
        return sendJson(res, 200, { requests });
      }
      if (req.query && req.query.view === "catalogs") {
        await requireWorkerPermission(req, "catalog_manage");
        const catalogs = await supabase(
          "/rest/v1/organization_catalogs?select=id,kind,name,description&order=kind.asc,name.asc"
        );
        return sendJson(res, 200, { catalogs });
      }
      await requireAdmin(req);
      if (req.query && req.query.view === "workers") {
        const [applications, accounts, warnings, roles] = await Promise.all([
          supabase("/rest/v1/worker_applications?select=email,name,status,created_at,reviewed_at,department,position,company,role_id&status=eq.approved&order=created_at.desc"),
          supabase("/rest/v1/worker_users?select=email,user_id,name"),
          supabase("/rest/v1/worker_warnings?select=email,message,created_at&order=created_at.desc"),
          supabase("/rest/v1/worker_roles?select=id,name,permissions&order=name.asc")
        ]);
        const workers = applications.map(application => ({
          ...application,
          accountCreated: accounts.some(account => account.email === application.email),
          warnings: warnings.filter(warning => warning.email === application.email)
        }));
        const roleMap = new Map(roles.map(role => [role.id, role]));
        workers.forEach(worker => {
          const role = roleMap.get(worker.role_id);
          worker.roleName = role ? role.name : "";
        });
        return sendJson(res, 200, { workers, roles });
      }
      const requests = await supabase(
        "/rest/v1/worker_applications?select=email,name,status,created_at,reviewed_at&order=created_at.desc"
      );
      return sendJson(res, 200, { requests });
    }

    const payload = body(req);

    if (req.method === "POST") {
      if (payload.action === "catalog_create") {
        await requireAdmin(req);
        const kind = payload.kind;
        const name = typeof payload.name === "string" ? payload.name.trim() : "";
        const description = typeof payload.description === "string" ? payload.description.trim() : "";
        if (!["company", "department", "job"].includes(kind)
          || !name || name.length > 120 || description.length > 800) {
          return sendJson(res, 400, { error: "Revisa el tipo, nombre (máximo 120) y descripción (máximo 800) del catálogo." });
        }
        const [catalog] = await supabase("/rest/v1/organization_catalogs", {
          method: "POST",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify({ kind, name, description })
        });
        return sendJson(res, 201, { catalog });
      }
      if (payload.action === "role_create") {
        await requireAdmin(req);
        const name = typeof payload.name === "string" ? payload.name.trim() : "";
        const permissions = normalizePermissions(payload.permissions);
        if (!name || name.length > 80 || name.toLocaleLowerCase("es") === "administrador" || !permissions) {
          return sendJson(res, 400, { error: "Revisa el nombre del rol y sus permisos." });
        }
        const [role] = await supabase("/rest/v1/worker_roles", {
          method: "POST",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify({ name, permissions })
        });
        return sendJson(res, 201, { role });
      }
      const email = normalizeEmail(payload.email);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
        return sendJson(res, 400, { error: "Escribe un correo electrónico válido." });
      }
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
        try {
          await deleteWorkerAuthAccount(email);
        } catch (error) {
          console.error("No se pudo limpiar la cuenta del trabajador despedido.", error.message);
          return sendJson(res, 503, { error: error.message });
        }
        await supabase(`/rest/v1/worker_applications?email=eq.${encodeURIComponent(email)}&status=eq.terminated`, {
          method: "PATCH",
          body: JSON.stringify({
            name,
            status: "pending",
            created_at: new Date().toISOString(),
            reviewed_at: null,
            reviewed_by: null,
            department: "",
            position: "",
            company: "",
            role_id: null
          })
        });
        return sendJson(res, 200, {
          ok: true,
          message: "Nueva solicitud enviada. Cuando el administrador la apruebe, podrás crear una cuenta nueva con este correo."
        });
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

    if (req.method === "DELETE") {
      await requireAdmin(req);
      if (payload.action === "catalog_delete" && typeof payload.id === "string") {
        const [catalog] = await supabase(
          `/rest/v1/organization_catalogs?id=eq.${encodeURIComponent(payload.id)}&select=id,kind,name&limit=1`
        );
        if (!catalog) return sendJson(res, 404, { error: "No se encontró el elemento del catálogo." });
        const field = catalog.kind === "department" ? "department" : catalog.kind === "job" ? "position" : "company";
        await supabase(`/rest/v1/worker_applications?${field}=eq.${encodeURIComponent(catalog.name)}`, {
          method: "PATCH",
          body: JSON.stringify({ [field]: "" })
        });
        await supabase(`/rest/v1/organization_catalogs?id=eq.${encodeURIComponent(catalog.id)}`, { method: "DELETE" });
        return sendJson(res, 200, { ok: true });
      }
      if (payload.action === "role_delete" && typeof payload.id === "string") {
        const [role] = await supabase(
          `/rest/v1/worker_roles?id=eq.${encodeURIComponent(payload.id)}&select=id,name&limit=1`
        );
        if (!role) return sendJson(res, 404, { error: "No se encontró el rol." });
        if (role.name === "Trabajador" || role.name === "Administrador") {
          return sendJson(res, 403, { error: "No se puede eliminar un rol protegido del sistema." });
        }
        await supabase(`/rest/v1/worker_roles?id=eq.${encodeURIComponent(payload.id)}`, { method: "DELETE" });
        return sendJson(res, 200, { ok: true });
      }
      return sendJson(res, 400, { error: "Selecciona un elemento válido para eliminar." });
    }

    const action = payload.action;
    const adminOnlyAction = ["catalog_update", "role_update", "update_profile", "reset_password", "warn", "dismiss"].includes(action);
    const admin = adminOnlyAction
      ? await requireAdmin(req)
      : await requireWorkerPermission(req, "applications_review");
    if (action === "catalog_update") {
      const id = typeof payload.id === "string" ? payload.id : "";
      const name = typeof payload.name === "string" ? payload.name.trim() : "";
      const description = typeof payload.description === "string" ? payload.description.trim() : "";
      if (!id || !name || name.length > 120 || description.length > 800) {
        return sendJson(res, 400, { error: "Revisa el nombre y la descripción del elemento." });
      }
      const [current] = await supabase(
        `/rest/v1/organization_catalogs?id=eq.${encodeURIComponent(id)}&select=id,kind,name&limit=1`
      );
      if (!current) return sendJson(res, 404, { error: "No se encontró el elemento del catálogo." });
      const rows = await supabase(`/rest/v1/organization_catalogs?id=eq.${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({ name, description })
      });
      if (current.name !== name) {
        const field = current.kind === "department" ? "department" : current.kind === "job" ? "position" : "company";
        await supabase(`/rest/v1/worker_applications?${field}=eq.${encodeURIComponent(current.name)}`, {
          method: "PATCH",
          body: JSON.stringify({ [field]: name })
        });
      }
      return sendJson(res, 200, { catalog: rows[0] });
    }
    if (action === "role_update") {
      const id = typeof payload.id === "string" ? payload.id : "";
      const name = typeof payload.name === "string" ? payload.name.trim() : "";
      const permissions = normalizePermissions(payload.permissions);
      if (!id || !name || name.length > 80 || name.toLocaleLowerCase("es") === "administrador" || !permissions) {
        return sendJson(res, 400, { error: "Revisa el nombre del rol y sus permisos." });
      }
      const [current] = await supabase(
        `/rest/v1/worker_roles?id=eq.${encodeURIComponent(id)}&select=id,name&limit=1`
      );
      if (!current) return sendJson(res, 404, { error: "No se encontró el rol." });
      if (current.name === "Administrador" || (current.name === "Trabajador" && name !== "Trabajador")) {
        return sendJson(res, 403, { error: "No se puede crear ni modificar un rol de administrador." });
      }
      const rows = await supabase(`/rest/v1/worker_roles?id=eq.${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({ name, permissions })
      });
      return sendJson(res, 200, { role: rows[0] });
    }
    if (!["approve", "reject", "warn", "dismiss", "update_profile", "reset_password"].includes(action)) {
      return sendJson(res, 400, { error: "Selecciona una acción válida para la solicitud." });
    }
    const email = normalizeEmail(payload.email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      return sendJson(res, 400, { error: "Escribe un correo electrónico válido." });
    }
    if (
      ["approve", "reject"].includes(action)
      && admin.role === "worker"
      && email === normalizeEmail(admin.email)
    ) {
      return sendJson(res, 403, { error: "No puedes revisar tu propia solicitud." });
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
      const roleId = typeof payload.role_id === "string" ? payload.role_id : null;
      if (department.length > 80 || position.length > 80 || company.length > 120) {
        return sendJson(res, 400, { error: "El departamento y cargo admiten hasta 80 caracteres; la empresa, 120." });
      }
      const assignments = [
        ["department", department],
        ["job", position],
        ["company", company]
      ].filter(([, name]) => name);
      const catalogMatches = await Promise.all(assignments.map(([kind, name]) =>
        supabase(`/rest/v1/organization_catalogs?kind=eq.${kind}&name=eq.${encodeURIComponent(name)}&select=id&limit=1`)
      ));
      if (catalogMatches.some(matches => matches.length === 0)) {
        return sendJson(res, 400, { error: "Selecciona un departamento, cargo y empresa de los catálogos vigentes." });
      }
      if (roleId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(roleId)) {
        return sendJson(res, 400, { error: "Selecciona un rol válido." });
      }
      if (roleId) {
        const [role] = await supabase(
          `/rest/v1/worker_roles?id=eq.${encodeURIComponent(roleId)}&select=id&limit=1`
        );
        if (!role) return sendJson(res, 400, { error: "Selecciona un rol válido." });
      }
      const rows = await supabase(
        `/rest/v1/worker_applications?email=eq.${encodeURIComponent(email)}&status=eq.approved`,
        {
          method: "PATCH",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify({ department, position, company, role_id: roleId })
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
      try {
        await deleteWorkerAuthAccount(email);
      } catch (error) {
        console.error("No se pudo eliminar la cuenta del trabajador despedido.", error.message);
        return sendJson(res, 503, { error: error.message });
      }
      await writeActivity(admin, "worker_dismissal", "Despidió a un trabajador", { email });
      return sendJson(res, 200, { ok: true, action: "dismiss" });
    }
    if (request.status !== "pending") {
      return sendJson(res, 409, { error: "Solo se pueden aprobar o rechazar solicitudes pendientes." });
    }
    const approvalRole = action === "approve"
      ? (await supabase("/rest/v1/worker_roles?name=eq.Trabajador&select=id&limit=1"))[0]
      : null;
    if (action === "approve" && !approvalRole) {
      return sendJson(res, 503, { error: "Falta el rol predeterminado Trabajador. Ejecuta supabase/schema.sql completo." });
    }
    const rows = await supabase(`/rest/v1/worker_applications?email=eq.${encodeURIComponent(email)}&select=email,status`, {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        status: action === "approve" ? "approved" : "rejected",
        reviewed_at: new Date().toISOString(),
        reviewed_by: admin.id,
        ...(approvalRole ? { role_id: approvalRole.id } : {})
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
      && [
        "worker_applications",
        "worker_users",
        "worker_warnings",
        "activity_events",
        "organization_catalogs",
        "worker_roles"
      ].some(table => databaseMessage.includes(table))
    ) {
      return sendJson(res, 503, {
        error: "Falta actualizar las tablas de trabajadores en Supabase. Ejecuta el archivo supabase/schema.sql completo y vuelve a intentarlo."
      });
    }
    return publicError(error, res);
  }
};
