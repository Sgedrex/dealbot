import "jsr:@supabase/functions-js/edge-runtime.d.ts";
// DealBot — agrega una categoría de monitoreo nueva con ayuda de IA.
// Recibe {pais, nombre}, Opus genera {slug, nombre, terminos, excluir}, se insertan las exclusiones
// baseline de higiene/cosmética (para que la categoría nazca limpia) y se hace INSERT en dealbot_categorias.
// La categoría queda activa -> el scraper la rastrea por palabra clave (no tiene mapeo de árbol todavía).
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MODEL = Deno.env.get("ADDCAT_MODEL") || "claude-opus-4-8";
const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "*", "content-type": "application/json" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: CORS });

// exclusiones baseline (mismo criterio que la limpieza de categorías contaminadas)
const BASE_EXCL = ["jabon", "shampoo", "champu", "detergente", "desinfectante", "locion", "corporal", "colonia", "exfoliante", "crema dental", "dental", "antibacterial", "desodorante", "talco", "protector solar", "enjuague bucal", "acondicionador", "toalla", "papel higienico"];

async function sbGet(path: string) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: { apikey: SB_KEY, authorization: `Bearer ${SB_KEY}` } });
  return r.ok ? await r.json() : [];
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const body = await req.json().catch(() => ({}));
    const pais = String(body.pais ?? "") === "CO" ? "CO" : "PA";
    const paisNombre = pais === "CO" ? "Colombia" : "Panamá";
    const nombreIn = String(body.nombre ?? "").trim().slice(0, 60);
    if (!nombreIn) return json({ ok: false, error: "Escribí el nombre de la categoría." });

    const KEY = Deno.env.get("ANTHROPIC_API_KEY");
    if (!KEY) return json({ ok: false, error: "Falta la API key de IA en el servidor." });

    // 1) IA genera la config
    const system = `Configurás categorías de monitoreo de precios de supermercados de ${paisNombre}. El usuario da el nombre de una categoría NUEVA de productos de supermercado (abarrotes/comida/bebida/cuidado). Devolvé UNICAMENTE un JSON válido con esta forma exacta:
{"slug":"identificador en snake_case sin acentos ni espacios (ej: pasta_tomate)","nombre":"Título legible con mayúscula inicial (ej: Pasta de tomate)","terminos":["entre 2 y 5 términos de búsqueda cortos y genéricos con los que un supermercado encuentra estos productos (ej para aceite: aceite, aceite de cocina, aceite girasol)"],"excluir":["palabras para descartar ruido: variantes NO comestibles o de otra categoría que las búsquedas suelen colar (ej para aceite: aceite corporal, aceite para bebe, aceite de motor)"]}
Reglas: slug corto y único; términos en singular, en español, que aparezcan literal en nombres de producto reales; NO inventes marcas. Nada de texto fuera del JSON.`;
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: 700, system, messages: [{ role: "user", content: `Categoría nueva: "${nombreIn}"` }] }),
    });
    const j = await r.json();
    if (!r.ok) return json({ ok: false, error: "IA no disponible: " + (j?.error?.message || r.status) });
    const texto = (Array.isArray(j.content) ? j.content.find((b: any) => b.type === "text")?.text : "") || "";
    const m = texto.match(/\{[\s\S]*\}/);
    if (!m) return json({ ok: false, error: "La IA no devolvió una configuración válida." });
    let cfg: any;
    try { cfg = JSON.parse(m[0]); } catch { return json({ ok: false, error: "No se pudo leer la configuración generada." }); }

    const slug = String(cfg.slug ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
    const nombre = String(cfg.nombre ?? nombreIn).trim().slice(0, 60);
    const terminos = Array.isArray(cfg.terminos) ? [...new Set(cfg.terminos.map((t: any) => String(t).toLowerCase().trim()).filter(Boolean))].slice(0, 6) : [];
    const exclIA = Array.isArray(cfg.excluir) ? cfg.excluir.map((e: any) => String(e).toLowerCase().trim()).filter(Boolean) : [];
    const excluir = [...new Set([...exclIA, ...BASE_EXCL])].slice(0, 60);
    if (!slug || !terminos.length) return json({ ok: false, error: "La IA no generó términos válidos." });

    // 2) dedup por (slug, pais)
    const existe = await sbGet(`dealbot_categorias?slug=eq.${encodeURIComponent(slug)}&pais=eq.${pais}&select=slug`);
    if (Array.isArray(existe) && existe.length) return json({ ok: false, error: `La categoría "${slug}" ya existe en ${paisNombre}.`, yaExiste: true, slug });

    // 3) orden = max+1
    const ord = await sbGet(`dealbot_categorias?pais=eq.${pais}&select=orden&order=orden.desc&limit=1`);
    const orden = (Array.isArray(ord) && ord[0]?.orden ? Number(ord[0].orden) : 0) + 1;

    // 4) INSERT
    const ins = await fetch(`${SB_URL}/rest/v1/dealbot_categorias`, {
      method: "POST",
      headers: { apikey: SB_KEY, authorization: `Bearer ${SB_KEY}`, "content-type": "application/json", prefer: "return=representation" },
      body: JSON.stringify({ slug, nombre, terminos, excluir, tiene_referencia: false, activo: true, orden, pais }),
    });
    if (!ins.ok) return json({ ok: false, error: "No se pudo guardar la categoría: " + (await ins.text()).slice(0, 200) });
    const fila = (await ins.json())?.[0] ?? { slug, nombre, terminos, excluir, pais };

    return json({ ok: true, categoria: { slug, nombre, terminos, excluir, pais }, modelo: MODEL, fila });
  } catch (e) {
    return json({ ok: false, error: "Error: " + ((e as Error)?.message || e) });
  }
});
