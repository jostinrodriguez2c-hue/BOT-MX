const { body, publicError, requireInventoryAccess, rpc, sendJson, supabase, writeActivity } = require("../lib/api");

const NOTIFICATION_FIELDS = "id,event_type,summary,details,actor_name,created_at";
const HISTORY_FIELDS = `${NOTIFICATION_FIELDS},actor_email`;

module.exports = async function handler(req, res) {
  if (!["GET", "POST"].includes(req.method)) {
    res.setHeader("Allow", "GET, POST");
    return sendJson(res, 405, { error: "Method not allowed." });
  }
  try {
    if (req.method === "POST") {
      const actor = await requireInventoryAccess(req);
      const payload = body(req);
      if (payload.action === "mark_read") {
        await supabase("/rest/v1/notification_reads?on_conflict=reader_email", {
          method: "POST",
          headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify({
            reader_email: actor.email.toLowerCase(),
            last_read_at: new Date().toISOString()
          })
        });
        return sendJson(res, 200, { ok: true });
      }

      const action = typeof payload.action === "string" ? payload.action.trim() : "";
      const detail = typeof payload.detail === "string" ? payload.detail.trim() : "";
      if (!action || action.length > 120 || !detail || detail.length > 500) {
        return sendJson(res, 400, { error: "La acción y el detalle son obligatorios y deben ser breves." });
      }
      const eventType = action === "Cierre de sesión" ? `${actor.role}_logout` : "admin_action";
      await writeActivity(actor, eventType, action, { detail });
      return sendJson(res, 201, { ok: true });
    }

    const authorization = req.headers.authorization || "";
    if (!authorization.startsWith("Bearer ")) {
      return sendJson(res, 200, { events: [], unreadCount: 0 });
    }

    const actor = await requireInventoryAccess(req);
    const email = encodeURIComponent(actor.email.toLowerCase());
    if (req.query && req.query.view === "history") {
      if (actor.role !== "admin") {
        return sendJson(res, 403, { error: "Solo una cuenta administradora autorizada puede ver el historial." });
      }
      const events = await supabase(
        `/rest/v1/activity_events?select=${HISTORY_FIELDS},visibility,recipient_email&order=created_at.desc&limit=100`
      );
      return sendJson(res, 200, { events });
    }

    const visibility = actor.role === "worker" ? "worker" : "admin";
    const [events, unreadCount] = await Promise.all([
      supabase(
        `/rest/v1/activity_events?visibility=eq.${visibility}&recipient_email=eq.${email}&select=${NOTIFICATION_FIELDS}&order=created_at.desc&limit=100`
      ),
      rpc("count_unread_notifications", {
        p_reader_email: actor.email.toLowerCase(),
        p_reader_role: actor.role
      })
    ]);
    const count = Number(unreadCount);
    if (!Array.isArray(events) || !Number.isSafeInteger(count) || count < 0) {
      throw new Error("Supabase returned invalid notification data.");
    }
    return sendJson(res, 200, { events, unreadCount: count });
  } catch (error) {
    return publicError(error, res);
  }
};
