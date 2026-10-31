const { body, onlyMethod, publicError, requireAdmin, sendJson, supabase } = require("../lib/api");

module.exports = async function handler(req, res) {
  if (!["GET", "POST", "DELETE"].includes(req.method)) {
    res.setHeader("Allow", "GET, POST, DELETE");
    return sendJson(res, 405, { error: "Method not allowed." });
  }
  try {
    await requireAdmin(req);
    if (req.method === "GET") {
      return sendJson(res, 200, {
        categories: await supabase("/rest/v1/product_categories?select=name&order=name.asc")
      });
    }
    const payload = body(req);
    const name = typeof payload.name === "string" ? payload.name.trim() : "";
    if (!name || name.length > 80) return sendJson(res, 400, { error: "Escribe una categoría de hasta 80 caracteres." });
    if (req.method === "POST") {
      await supabase("/rest/v1/product_categories", {
        method: "POST",
        headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
        body: JSON.stringify({ name })
      });
      return sendJson(res, 201, { ok: true });
    }
    const assigned = await supabase(`/rest/v1/products?category=eq.${encodeURIComponent(name)}&active=eq.true&select=id&limit=1`);
    if (assigned.length) return sendJson(res, 409, { error: "No se puede quitar una categoría que todavía usan productos activos." });
    await supabase(`/rest/v1/product_categories?name=eq.${encodeURIComponent(name)}`, { method: "DELETE" });
    return sendJson(res, 200, { ok: true });
  } catch (error) {
    return publicError(error, res);
  }
};
