const crypto = require("node:crypto");
const {
  body,
  decryptWorkerActivationCode,
  encryptWorkerActivationCode,
  getEnv,
  publicError,
  requireAdmin,
  requireWorkerPermission,
  SUPER_ADMIN_OWNER_EMAIL,
  SUPER_ADMIN_ROLE_NAME,
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

async function issueWorkerActivationCode(email) {
  const code = String(crypto.randomInt(0, 10000)).padStart(4, "0");
  const codeHash = crypto.createHmac("sha256", getEnv("SUPABASE_SERVICE_ROLE_KEY"))
    .update(code)
    .digest("hex");
  const rows = await supabase(
    `/rest/v1/worker_applications?email=eq.${encodeURIComponent(email)}&status=eq.approved`,
    {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        activation_code_hash: codeHash,
        activation_code_ciphertext: encryptWorkerActivationCode(code),
        activation_code_expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        activation_code_attempts: 0
      })
    }
  );
  if (!rows.length) throw new Error("La solicitud ya no está aprobada; no se pudo generar el código.");
  return code;
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
        const admin = await requireAdmin(req);
        const [catalogs, roles] = await Promise.all([
          supabase("/rest/v1/organization_catalogs?select=id,kind,name,description&order=kind.asc,name.asc"),
          supabase("/rest/v1/worker_roles?select=id,name,permissions&order=name.asc")
        ]);
        return sendJson(res, 200, {
          catalogs,
          roles,
          canManageSupremeRole: Boolean(admin.isSuperAdminManager)
        });
      }
      if (req.query && req.query.view === "requests") {
        await requireAdmin(req);
        const requests = await supabase(
          "/rest/v1/worker_applications?select=email,name,status,created_at,reviewed_at&status=eq.pending&order=created_at.desc"
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
      const admin = await requireAdmin(req);
      if (req.query && req.query.view === "workers") {
        const [applications, accounts, warnings, roles] = await Promise.all([
          supabase("/rest/v1/worker_applications?select=email,name,status,created_at,reviewed_at,department,position,company,role_id,activation_code_ciphertext,activation_code_expires_at,activation_code_attempts&status=eq.approved&order=created_at.desc"),
          supabase("/rest/v1/worker_users?select=email,user_id,name"),
          supabase("/rest/v1/worker_warnings?select=email,message,created_at&order=created_at.desc"),
          supabase("/rest/v1/worker_roles?select=id,name,permissions&order=name.asc")
        ]);
        const accountEmails = new Set(accounts.map(account => account.email));
        const workers = applications.map(application => {
          const accountCreated = accountEmails.has(application.email);
          const codeExpiresAt = application.activation_code_expires_at;
          const codeIsActive = !accountCreated
            && application.activation_code_ciphertext
            && Number(application.activation_code_attempts) < 5
            && codeExpiresAt
            && new Date(codeExpiresAt).getTime() > Date.now();
          const safeApplication = { ...application };
          delete safeApplication.activation_code_ciphertext;
          delete safeApplication.activation_code_attempts;
          return {
            ...safeApplication,
            accountCreated,
            activationCode: codeIsActive
              ? decryptWorkerActivationCode(application.activation_code_ciphertext)
              : "",
            activation_code_expires_at: codeIsActive ? codeExpiresAt : null,
            warnings: warnings.filter(warning => warning.email === application.email)
          };
        });
        const roleMap = new Map(roles.map(role => [role.id, role]));
        workers.forEach(worker => {
          const role = roleMap.get(worker.role_id);
          worker.roleName = role ? role.name : "";
        });
        return sendJson(res, 200, {
          workers,
          roles,
          canManageSupremeRole: Boolean(admin.isSuperAdminManager)
        });
      }
      const requests = await supabase(
        "/rest/v1/worker_applications?select=email,name,status,created_at,reviewed_at&status=eq.pending&order=created_at.desc"
      );
      return sendJson(res, 200, { requests });
    }

    const payload = body(req);

    if (req.method === "POST") {
      if (payload.action === "application_notification") {
        const token = typeof payload.applicationToken === "string" ? payload.applicationToken : "";
        if (!/^[a-f0-9]{64}$/i.test(token)) {
          return sendJson(res, 400, { error: "El acceso a las notificaciones de la solicitud no es válido." });
        }
        const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
        const [application] = await supabase(
          `/rest/v1/worker_applications?application_notification_token_hash=eq.${tokenHash}&select=email,status,reviewed_at&limit=1`
        );
        if (!application) {
          return sendJson(res, 404, { error: "No se encontró una solicitud asociada a estas notificaciones." });
        }
        if (!["approved", "rejected"].includes(application.status) || !application.reviewed_at) {
          return sendJson(res, 200, { notification: null });
        }
        const approved = application.status === "approved";
        return sendJson(res, 200, {
          notification: {
            id: `application-decision-${application.email}-${application.reviewed_at}`,
            event_type: "worker_application_decision",
            summary: approved ? "Tu solicitud fue aprobada" : "Tu solicitud fue rechazada",
            details: {
              message: approved
                ? "Contacta al administrador para recibir tu código temporal y activar tu cuenta."
                : "Si tienes preguntas, comunícate con el administrador."
            },
            actor_name: "Wilcox Company",
            created_at: application.reviewed_at
          }
        });
      }
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
        if (!name || name.length > 80
          || ["administrador", SUPER_ADMIN_ROLE_NAME.toLocaleLowerCase("es")].includes(name.toLocaleLowerCase("es"))
          || !permissions) {
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
      const applicationToken = typeof payload.applicationToken === "string" ? payload.applicationToken : "";
      if (!/^[a-f0-9]{64}$/i.test(applicationToken)) {
        return sendJson(res, 400, { error: "No se pudieron activar las notificaciones de tu solicitud. Recarga la página e inténtalo otra vez." });
      }
      const applicationTokenHash = crypto.createHash("sha256").update(applicationToken).digest("hex");
      const [existing] = await supabase(
        `/rest/v1/worker_applications?email=eq.${encodeURIComponent(email)}&select=status,application_notification_token_hash&limit=1`
      );
      if (existing && existing.status === "approved") {
        return sendJson(res, 409, { error: "Esta solicitud ya fue aprobada. Pide el código temporal al administrador para activar el acceso." });
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
            application_notification_token_hash: applicationTokenHash,
            created_at: new Date().toISOString(),
            reviewed_at: null,
            reviewed_by: null,
            department: "",
            position: "",
            company: "",
            role_id: null,
            activation_code_hash: null,
            activation_code_ciphertext: null,
            activation_code_expires_at: null,
            activation_code_attempts: 0
          })
        });
        return sendJson(res, 200, {
          ok: true,
          message: "Nueva solicitud enviada. Si la aprueban, el administrador te entregará un código temporal para activar el acceso."
        });
      }
      if (existing && existing.status === "pending") {
        const ownsNotificationToken = existing.application_notification_token_hash === applicationTokenHash;
        if (ownsNotificationToken) {
          await supabase(`/rest/v1/worker_applications?email=eq.${encodeURIComponent(email)}`, {
            method: "PATCH",
            body: JSON.stringify({ name })
          });
        }
        return sendJson(res, 200, {
          ok: true,
          notificationsEnabled: ownsNotificationToken,
          message: "La solicitud ya está pendiente de revisión."
        });
      }
      await supabase("/rest/v1/worker_applications", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({
          email,
          name,
          status: "pending",
          application_notification_token_hash: applicationTokenHash,
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
        await requireAdmin(req);
        const [role] = await supabase(
          `/rest/v1/worker_roles?id=eq.${encodeURIComponent(payload.id)}&select=id,name&limit=1`
        );
        if (!role) return sendJson(res, 404, { error: "No se encontró el rol." });
        if (role.name === "Trabajador" || role.name === "Administrador" || role.name === SUPER_ADMIN_ROLE_NAME) {
          return sendJson(res, 403, { error: "No se puede eliminar un rol protegido del sistema." });
        }
        await supabase(`/rest/v1/worker_roles?id=eq.${encodeURIComponent(payload.id)}`, { method: "DELETE" });
        return sendJson(res, 200, { ok: true });
      }
      return sendJson(res, 400, { error: "Selecciona un elemento válido para eliminar." });
    }

    const action = payload.action;
    const admin = await requireAdmin(req);
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
      if (!id || !name || name.length > 80
        || ["administrador", SUPER_ADMIN_ROLE_NAME.toLocaleLowerCase("es")].includes(name.toLocaleLowerCase("es"))
        || !permissions) {
        return sendJson(res, 400, { error: "Revisa el nombre del rol y sus permisos." });
      }
      const [current] = await supabase(
        `/rest/v1/worker_roles?id=eq.${encodeURIComponent(id)}&select=id,name&limit=1`
      );
      if (!current) return sendJson(res, 404, { error: "No se encontró el rol." });
      if (current.name === SUPER_ADMIN_ROLE_NAME && !admin.isSuperAdminManager) {
        return sendJson(res, 403, { error: "Solo el administrador supremo principal puede modificar este rol." });
      }
      if (current.name === "Administrador" || current.name === SUPER_ADMIN_ROLE_NAME
        || (current.name === "Trabajador" && name !== "Trabajador")) {
        return sendJson(res, 403, { error: "No se puede crear ni modificar un rol de administrador." });
      }
      const rows = await supabase(`/rest/v1/worker_roles?id=eq.${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({ name, permissions })
      });
      return sendJson(res, 200, { role: rows[0] });
    }
    if (!["approve", "reject", "warn", "dismiss", "update_profile", "reset_password", "issue_activation_code"].includes(action)) {
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
      `/rest/v1/worker_applications?email=eq.${encodeURIComponent(email)}&select=email,name,status,department,position,company,role_id&limit=1`
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
          `/rest/v1/worker_roles?id=eq.${encodeURIComponent(roleId)}&select=id,name&limit=1`
        );
        if (!role) return sendJson(res, 400, { error: "Selecciona un rol válido." });
        if (role.name === SUPER_ADMIN_ROLE_NAME && !admin.isSuperAdminManager) {
          return sendJson(res, 403, { error: `Solo ${SUPER_ADMIN_OWNER_EMAIL} puede asignar el rol Administrador supremo.` });
        }
      }
      if (request.role_id) {
        const [currentRole] = await supabase(
          `/rest/v1/worker_roles?id=eq.${encodeURIComponent(request.role_id)}&select=name&limit=1`
        );
        if (currentRole && currentRole.name === SUPER_ADMIN_ROLE_NAME && !admin.isSuperAdminManager) {
          return sendJson(res, 403, { error: "Solo el administrador supremo principal puede cambiar la asignación de ese rol." });
        }
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
    if (action === "issue_activation_code") {
      if (request.status !== "approved") {
        return sendJson(res, 409, { error: "Solo se puede generar un código para una solicitud aprobada." });
      }
      const [account] = await supabase(
        `/rest/v1/worker_users?email=eq.${encodeURIComponent(email)}&select=user_id&limit=1`
      );
      if (account) {
        return sendJson(res, 409, { error: "Este trabajador ya activó su cuenta; debe iniciar sesión o restablecer su contraseña." });
      }
      const activationCode = await issueWorkerActivationCode(email);
      return sendJson(res, 200, {
        ok: true,
        message: "Código temporal generado. Está visible en Datos laborales de Personas; vence en 24 horas y solo se usa una vez."
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
          reviewed_by: admin.id,
          activation_code_hash: null,
          activation_code_ciphertext: null,
          activation_code_expires_at: null,
          activation_code_attempts: 0
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
    const activationCode = action === "approve" ? String(crypto.randomInt(0, 10000)).padStart(4, "0") : null;
    const activationCodeHash = activationCode
      ? crypto.createHmac("sha256", getEnv("SUPABASE_SERVICE_ROLE_KEY")).update(activationCode).digest("hex")
      : null;
    const rows = await supabase(`/rest/v1/worker_applications?email=eq.${encodeURIComponent(email)}&select=email,status`, {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        status: action === "approve" ? "approved" : "rejected",
        reviewed_at: new Date().toISOString(),
        reviewed_by: admin.id,
        ...(approvalRole ? { role_id: approvalRole.id } : {}),
        activation_code_hash: activationCodeHash,
        activation_code_ciphertext: activationCode ? encryptWorkerActivationCode(activationCode) : null,
        activation_code_expires_at: activationCode ? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() : null,
        activation_code_attempts: 0
      })
    });
    if (!rows.length) return sendJson(res, 404, { error: "No se encontró la solicitud." });
    const decisionApproved = action === "approve";
    try {
      await writeActivity(
        admin,
        "worker_application_decision",
        decisionApproved ? "Tu solicitud fue aprobada" : "Tu solicitud fue rechazada",
        {
          message: decisionApproved
            ? "Contacta al administrador para recibir tu código temporal y activar tu cuenta."
            : "Si tienes preguntas, comunícate con el administrador."
        },
        "worker",
        email
      );
    } catch (error) {
      console.error("No se pudo crear la notificación de decisión de solicitud.", error.message);
    }
    await writeActivity(
      admin,
      action === "approve" ? "worker_approval" : "worker_rejection",
      action === "approve" ? "Aprobó a un trabajador" : "Rechazó una solicitud de trabajador",
      { email, name: request.name || "" }
    );
    return sendJson(res, 200, {
      ok: true,
      status: rows[0].status,
      ...(activationCode ? { activationCodeIssued: true } : {})
    });
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
