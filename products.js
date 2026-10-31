const { publicError, rpc, sendJson, supabase } = require("../lib/api");

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return sendJson(res, 405, { error: "Method not allowed." });
  }
  try {
    await rpc("release_expired_orders", {});
    const [products, categories] = await Promise.all([
      supabase("/rest/v1/products?active=eq.true&select=id,name,category,unit,stock,reserved,price_cents&order=name.asc"),
      supabase("/rest/v1/product_categories?select=name&order=name.asc")
    ]);
    return sendJson(res, 200, {
      products: products.map(product => ({
        ...product,
        available: Math.max(0, product.stock - product.reserved)
      })),
      categories: categories.map(category => category.name)
    });
  } catch (error) {
    return publicError(error, res);
  }
};
