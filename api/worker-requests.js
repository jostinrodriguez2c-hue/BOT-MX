const { body, publicError, requireAdmin, sendJson, supabase } = require("../lib/api");

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
      await requireAdmin(req);
      const requests = await supabase(
        "/rest/v1/worker_applications?select=email,status,created_at,reviewed_at&order=created_at.desc"
      );
      return sendJson(res, 200, { requests });
    }

    const payload = body(req);
    const email = normalizeEmail(payload.email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      return sendJson(res, 400, { error: "Escribe un correo electrónico válido." });
    }

    if (req.method === "POST") {
      const [existing] = await supabase(
        `/rest/v1/worker_applications?email=eq.${encodeURIComponent(email)}&select=status&limit=1`
      );
      if (existing && existing.status === "approved") {
        return sendJson(res, 409, { error: "Esta solicitud ya fue aprobada. Crea tu cuenta en la sección Trabajador." });
      }
      if (existing && existing.status === "pending") {
        return sendJson(res, 200, { ok: true, message: "La solicitud ya está pendiente de revisión." });
      }
      await supabase("/rest/v1/worker_applications", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({
          email,
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
    if (!["approve", "reject"].includes(action)) {
      return sendJson(res, 400, { error: "Selecciona aceptar o rechazar la solicitud." });
    }
    const [request] = await supabase(
      `/rest/v1/worker_applications?email=eq.${encodeURIComponent(email)}&select=email,status&limit=1`
    );
    if (!request) return sendJson(res, 404, { error: "No se encontró la solicitud." });
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
    return sendJson(res, 200, { ok: true, status: rows[0].status });
  } catch (error) {
    return publicError(error, res);
  }
};
