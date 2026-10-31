const { body, onlyMethod, publicError, requireAdmin, sendJson, supabase } = require("../lib/api");

function validProduct(value, partial) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const required = ["name", "category", "unit", "stock", "price_cents"];
  if (!partial && required.some(key => !(key in value))) return false;
  if ("name" in value && (typeof value.name !== "string" || value.name.trim().length < 1 || value.name.trim().length > 120)) return false;
  if ("category" in value && (typeof value.category !== "string" || value.category.length > 80)) return false;
  if ("unit" in value && (typeof value.unit !== "string" || value.unit.trim().length < 1 || value.unit.trim().length > 30)) return false;
  if ("stock" in value && (!Number.isSafeInteger(value.stock) || value.stock < 0)) return false;
  if ("price_cents" in value && (!Number.isSafeInteger(value.price_cents) || value.price_cents < 1)) return false;
  return true;
}

module.exports = async function handler(req, res) {
  if (!["GET", "POST", "PATCH", "DELETE"].includes(req.method)) {
    res.setHeader("Allow", "GET, POST, PATCH, DELETE");
    return sendJson(res, 405, { error: "Method not allowed." });
  }
  try {
    await requireAdmin(req);
    if (req.method === "GET") {
      const products = await supabase("/rest/v1/products?active=eq.true&select=*&order=name.asc");
      return sendJson(res, 200, { products });
    }
    const payload = body(req);
    if (req.method === "POST") {
      if (!validProduct(payload, false)) return sendJson(res, 400, { error: "Revisa los datos del producto y el precio en centavos de dólar." });
      const [product] = await supabase("/rest/v1/products", {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({
          name: payload.name.trim(),
          category: payload.category.trim(),
          unit: payload.unit.trim(),
          stock: payload.stock,
          price_cents: payload.price_cents
        })
      });
      return sendJson(res, 201, { product });
    }
    if (typeof payload.id !== "string") return sendJson(res, 400, { error: "Falta el identificador del producto." });
    if (req.method === "PATCH") {
      const updates = { ...payload };
      delete updates.id;
      const allowedFields = new Set(["name", "category", "unit", "stock", "price_cents"]);
      if (Object.keys(updates).some(key => !allowedFields.has(key))
        || !validProduct(updates, true) || Object.keys(updates).length === 0) {
        return sendJson(res, 400, { error: "Los datos del producto no son válidos." });
      }
      if (updates.stock !== undefined) {
        const [current] = await supabase(`/rest/v1/products?id=eq.${encodeURIComponent(payload.id)}&select=reserved&limit=1`);
        if (!current) return sendJson(res, 404, { error: "No se encontró el producto." });
        if (updates.stock < current.reserved) return sendJson(res, 409, { error: "El inventario no puede quedar por debajo de las unidades reservadas para compras." });
      }
      const rows = await supabase(`/rest/v1/products?id=eq.${encodeURIComponent(payload.id)}&select=*`, {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify(updates)
      });
      if (!rows.length) return sendJson(res, 404, { error: "No se encontró el producto." });
      return sendJson(res, 200, { product: rows[0] });
    }
    const rows = await supabase(`/rest/v1/products?id=eq.${encodeURIComponent(payload.id)}&select=reserved`, {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({ active: false })
    });
    if (!rows.length) return sendJson(res, 404, { error: "No se encontró el producto." });
    return sendJson(res, 200, { ok: true });
  } catch (error) {
    return publicError(error, res);
  }
};
