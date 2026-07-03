import "jsr:@supabase/functions-js/edge-runtime.d.ts";
// DealBot Colombia — scrapea Éxito, Carulla, Jumbo y Olímpica (todas VTEX) y guarda precios (COP, pais='CO').
// Éxito/Carulla usan el path /io/api; Jumbo vive en jumbocolombia.com. Paginamos 2 páginas (100 prod/término).

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";
const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "POST, GET, OPTIONS", "access-control-allow-headers": "*", "content-type": "application/json" };

const TIENDAS = [
  { slug: "exito",    api: "https://www.exito.com/io",        dominio: "www.exito.com" },
  { slug: "carulla",  api: "https://www.carulla.com/io",      dominio: "www.carulla.com" },
  { slug: "jumbo",    api: "https://www.jumbocolombia.com",    dominio: "www.jumbocolombia.com" },
  { slug: "olimpica", api: "https://www.olimpica.com",         dominio: "www.olimpica.com" },
];

function mapVtex(arr: any[], retailer: string, dominio: string) {
  return arr.map((p: any) => { const item = p.items?.[0] ?? {}; const offer = item.sellers?.[0]?.commertialOffer ?? {}; return { retailer, product_id: String(p.productId), ean: item.ean ?? "", nombre: p.productName ?? "", marca: p.brand ?? "", link: `https://${dominio}/${p.linkText}/p`, price: Number(offer.Price ?? 0), list_price: offer.ListPrice != null ? String(offer.ListPrice) : "", disponible: Number(offer.AvailableQuantity ?? 0) > 0 && offer.IsAvailable !== false, pais: "CO" }; }).filter((x: any) => x.price > 0);
}

async function fetchVtexCO(t: { slug: string; api: string; dominio: string }, term: string) {
  const out: any[] = []; const seen = new Set<string>();
  for (const [from, to] of [[0, 49], [50, 99]]) {
    const res = await fetch(`${t.api}/api/catalog_system/pub/products/search?ft=${encodeURIComponent(term)}&_from=${from}&_to=${to}`, { headers: { accept: "application/json", "user-agent": UA }, redirect: "follow" });
    if (!res.ok && res.status !== 206) break;
    let arr: any[] = [];
    try { arr = await res.json(); } catch { break; }
    if (!Array.isArray(arr) || !arr.length) break;
    for (const it of mapVtex(arr, t.slug, t.dominio)) { if (seen.has(it.product_id)) continue; seen.add(it.product_id); out.push(it); }
    if (arr.length < 50) break;
  }
  return out;
}

async function rpc(fn: string, args: any) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, { method: "POST", headers: { "content-type": "application/json", apikey: SERVICE_KEY, authorization: `Bearer ${SERVICE_KEY}` }, body: JSON.stringify(args) });
  if (!res.ok) throw new Error(`rpc ${fn} ${res.status}: ${await res.text()}`);
  return await res.json();
}
async function getCategorias() {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/dealbot_categorias?activo=eq.true&pais=eq.CO&select=slug,terminos,excluir&order=orden`, { headers: { apikey: SERVICE_KEY, authorization: `Bearer ${SERVICE_KEY}` } });
  return res.ok ? await res.json() : [];
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const t0 = Date.now();
  try {
    const cats = await getCategorias();
    if (!cats.length) return new Response(JSON.stringify({ ok: false, error: "sin categorias CO" }), { status: 400, headers: CORS });
    const seen = new Set<string>(); const items: any[] = []; const porCat: any = {}; const porTienda: any = {};
    for (const cat of cats) {
      const excl = (cat.excluir ?? []).map((e: string) => e.toLowerCase());
      const tasks: Promise<any[]>[] = [];
      for (const term of cat.terminos) for (const t of TIENDAS) tasks.push(fetchVtexCO(t, term).catch(() => []));
      const found = (await Promise.all(tasks)).flat();
      let added = 0;
      for (const it of found) {
        const nm = (it.nombre ?? "").toLowerCase();
        if (excl.some((e: string) => nm.includes(e))) continue;
        const k = it.retailer + "|" + it.product_id;
        if (seen.has(k)) continue; seen.add(k);
        it.categoria = cat.slug; items.push(it); added++;
        porTienda[it.retailer] = (porTienda[it.retailer] || 0) + 1;
      }
      porCat[cat.slug] = added;
    }
    const guardados = items.length ? await rpc("dealbot_upsert_batch", { items }) : 0;
    return new Response(JSON.stringify({ ok: true, pais: "CO", porCategoria: porCat, porTienda, scrapeados: items.length, guardados, ms: Date.now() - t0 }), { headers: CORS });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: CORS });
  }
});
