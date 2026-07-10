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

function sinAcentos(s: string): string {
  return (s || "").normalize("NFD").replace(/\p{Mn}/gu, "");
}

// ===== Navegacion por categoria real (mismo patron que dealbot-scan PA) =====
// Las 4 tiendas son VTEX: se navega la ruta real de categoria en vez de buscar por palabra suelta.
// `shared:true` = la ruta agrupa VARIAS categorias nuestras a la vez (ej. "Enlatados y conservas" trae
// atun+sardinas+vegetales+duraznos+ensaladas de una sola tienda) -> se filtra por las palabras propias
// de ESA categoria (`dealbot_categorias.terminos`) dentro del lote ya acotado.
// Verificado con muestras reales (curl directo) antes de fijar cada ruta — Éxito/Carulla/Jumbo agrupan
// TODO lo enlatado bajo una sola categoria "Enlatados y conservas"; Olimpica lo separa en "Carnes Enlatadas"
// (atun/sardinas/ensaladas), "Vegetales Envasados" (maiz/arvejas) y "Dulces Y Conservas" (duraznos).
// "harina" se deja shared:true en las 4 porque el bucket real mezcla harina de trigo CON harina de maiz/
// mezclas para arepa (verificado con muestra de 15 items) — sin el filtro por "harina de trigo" se cuela maiz.
// "avena" queda shared:false (bucket limpio de un solo tema en las 3 muestras) para no perder productos
// reales cuyo nombre no calza exacto con la frase completa "avena en hojuelas" (ej. "Avena En Hojuela").
// Avena en Olimpica y "comida_mascotas" (las 4 tiendas) se dejan en busqueda por palabra clave (fallback):
// sus terminos son frases largas que no aparecen literal en los nombres de producto navegando la categoria,
// pero SI funcionan bien como termino de busqueda `ft=` (ranking propio de VTEX), verificado con muestra real.
type CatMapEntry = { paths: string[]; shared?: boolean };
const CATEGORY_MAP_CO: Record<string, Record<string, CatMapEntry>> = {
  exito: {
    atun: { paths: ["mercado/despensa/enlatados-y-conservas"], shared: true },
    sardinas: { paths: ["mercado/despensa/enlatados-y-conservas"], shared: true },
    vegetales_enlatados: { paths: ["mercado/despensa/enlatados-y-conservas"], shared: true },
    duraznos: { paths: ["mercado/despensa/enlatados-y-conservas"], shared: true },
    ensaladas: { paths: ["mercado/despensa/enlatados-y-conservas"], shared: true },
    harina: { paths: ["mercado/despensa/harinas-y-mezclas-para-preparar"], shared: true },
    pasta_tomate: { paths: ["mercado/despensa/salsas-especias-y-condimentos"], shared: true },
    avena: { paths: ["mercado/despensa/avena-en-hojuelas-y-en-polvo"] },
  },
  carulla: {
    atun: { paths: ["despensa/enlatados-y-conservas"], shared: true },
    sardinas: { paths: ["despensa/enlatados-y-conservas"], shared: true },
    vegetales_enlatados: { paths: ["despensa/enlatados-y-conservas"], shared: true },
    duraznos: { paths: ["despensa/enlatados-y-conservas"], shared: true },
    ensaladas: { paths: ["despensa/enlatados-y-conservas"], shared: true },
    harina: { paths: ["despensa/harinas-y-mezclas-para-preparar/harina-de-trigo-y-maiz"], shared: true },
    pasta_tomate: { paths: ["despensa/salsas-condimentos-y-especias/salsas-de-cocina-y-bases"], shared: true },
    avena: { paths: ["despensa/cereales-granolas-y-avenas/avena-en-hojuelas-y-molida"] },
  },
  jumbo: {
    atun: { paths: ["supermercado/despensa/enlatados-y-conservas"], shared: true },
    sardinas: { paths: ["supermercado/despensa/enlatados-y-conservas"], shared: true },
    vegetales_enlatados: { paths: ["supermercado/despensa/enlatados-y-conservas"], shared: true },
    duraznos: { paths: ["supermercado/despensa/enlatados-y-conservas"], shared: true },
    ensaladas: { paths: ["supermercado/despensa/enlatados-y-conservas"], shared: true },
    harina: { paths: ["supermercado/despensa/harinas-y-mezclas-para-preparar"], shared: true },
    pasta_tomate: { paths: ["supermercado/despensa/salsas-y-vinagres"], shared: true },
    avena: { paths: ["supermercado/despensa/avenas-y-salvado"] },
  },
  olimpica: {
    atun: { paths: ["supermercado/despensa/carnes-enlatadas"], shared: true },
    sardinas: { paths: ["supermercado/despensa/carnes-enlatadas"], shared: true },
    ensaladas: { paths: ["supermercado/despensa/carnes-enlatadas"], shared: true },
    vegetales_enlatados: { paths: ["supermercado/despensa/vegetales-envasados"], shared: true },
    duraznos: { paths: ["supermercado/despensa/dulces-y-conservas"], shared: true },
    harina: { paths: ["supermercado/despensa/harinas"], shared: true },
    pasta_tomate: { paths: ["supermercado/despensa/salsas-aderezos-condimentos"], shared: true },
  },
};

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

// VTEX por categoria real: navega la ruta del arbol en vez de buscar por palabra (mismo mecanismo que PA).
async function fetchVtexCoPorCategoria(t: { slug: string; api: string; dominio: string }, path: string, maxItems = 50): Promise<any[]> {
  const map = path.split("/").map(() => "c").join(",");
  const out: any[] = [];
  for (let from = 0; from < maxItems; from += 50) {
    const to = from + 49;
    let res: Response;
    try { res = await fetch(`${t.api}/api/catalog_system/pub/products/search/${path}?map=${map}&_from=${from}&_to=${to}`, { headers: { accept: "application/json", "user-agent": UA }, redirect: "follow" }); }
    catch { break; }
    if (!res.ok && res.status !== 206) break;
    let json: any;
    try { json = await res.json(); } catch { break; }
    if (!Array.isArray(json) || !json.length) break;
    out.push(...mapVtex(json, t.slug, t.dominio));
    if (json.length < 50) break;
  }
  return out;
}

// cache por corrida: una ruta compartida entre varias categorias nuestras (ej. "Enlatados y conservas" de
// Exito sirve para atun+sardinas+vegetales+duraznos+ensaladas) se trae UNA sola vez, no una vez por categoria.
const catFetchCache = new Map<string, Promise<any[]>>();
async function fetchPorCategoriaCO(tiendaSlug: string, catSlug: string): Promise<any[] | null> {
  const t = TIENDAS.find((x) => x.slug === tiendaSlug)!;
  const mapa = CATEGORY_MAP_CO[tiendaSlug]?.[catSlug];
  if (!mapa) return null; // sin mapeo -> el llamador usa busqueda por palabra como antes
  const cacheKey = tiendaSlug + "::" + JSON.stringify(mapa.paths);
  if (!catFetchCache.has(cacheKey)) {
    const p = Promise.all(mapa.paths.map((path) => fetchVtexCoPorCategoria(t, path))).then((a) => a.flat()).catch(() => []);
    catFetchCache.set(cacheKey, p);
  }
  return await catFetchCache.get(cacheKey)!;
}

// Makro CO: Instaleap (misma plataforma que Super Rey PA). ean llega como array. ARO/M&C = marcas blancas del usuario.
// Su filtro de categorias nunca funciono en pruebas (igual que Super Rey PA) -> se queda 100% por palabra clave.
async function fetchMakro(term: string) {
  const body = [{ operationName: "SearchProducts", variables: { searchProductsInput: { clientId: "MAKRO", storeReference: "08DEL", currentPage: 1, pageSize: 50, search: { query: term } } }, query: "query SearchProducts($searchProductsInput: SearchProductsInput!) { searchProducts(searchProductsInput: $searchProductsInput) { products { sku ean name price stock isAvailable } } }" }];
  const res = await fetch("https://nextgentheadless.instaleap.io/api/v3", { method: "POST", headers: { "content-type": "application/json", "dpl-api-key": "004e38b8-8d34-4fd2-81f1-036d3359beba", "apollographql-client-name": "e-commerce Moira Engine client MAKRO", "apollographql-client-version": "0.19.199" }, body: JSON.stringify(body) });
  if (!res.ok) return [];
  const json = await res.json();
  const prods = json?.[0]?.data?.searchProducts?.products ?? [];
  return prods.map((p: any) => ({ retailer: "makro", product_id: String(p.sku), ean: String(Array.isArray(p.ean) ? (p.ean[0] ?? "") : (p.ean ?? "")), nombre: p.name ?? "", marca: "", link: `https://tienda.makro.com.co/search?q=${encodeURIComponent(p.name ?? "")}`, price: Number(p.price ?? 0), list_price: "", disponible: p.isAvailable !== false && Number(p.stock ?? 1) > 0, pais: "CO" })).filter((x: any) => x.price > 0);
}

async function rpc(fn: string, args: any) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, { method: "POST", headers: { "content-type": "application/json", apikey: SERVICE_KEY, authorization: `Bearer ${SERVICE_KEY}` }, body: JSON.stringify(args) });
  if (!res.ok) throw new Error(`rpc ${fn} ${res.status}: ${await res.text()}`);
  return await res.json();
}
async function getCategorias() {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/dealbot_categorias?activo=eq.true&pais=eq.CO&select=slug,nombre,terminos,excluir&order=orden`, { headers: { apikey: SERVICE_KEY, authorization: `Bearer ${SERVICE_KEY}` } });
  return res.ok ? await res.json() : [];
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const t0 = Date.now();
  // modo traza: ?explain=1 devuelve el RAZONAMIENTO del scraper (metodo/ruta/conteos por categoria x tienda)
  // haciendo los fetch reales pero SIN escribir en la BD. Sirve para visualizar como "piensa" cada corrida.
  const explain = new URL(req.url).searchParams.get("explain") === "1";
  try {
    const cats = await getCategorias();
    if (!cats.length) return new Response(JSON.stringify({ ok: false, error: "sin categorias CO" }), { status: 400, headers: CORS });
    const seen = new Set<string>(); const items: any[] = []; const porCat: any = {}; const porTienda: any = {};
    const traza: any[] = [];
    for (const cat of cats) {
      const excl = (cat.excluir ?? []).map((e: string) => e.toLowerCase());
      const terminosIncl = (cat.terminos ?? []).map((t: string) => sinAcentos(t.toLowerCase()));
      // Tiendas en SECUENCIA (no Promise.all): parsear varios JSON grandes de VTEX al mismo tiempo
      // agotaba el limite de CPU del edge runtime (WORKER_RESOURCE_LIMIT) con el enfoque concurrente.
      const found: any[] = [];
      const pasos: any[] = [];   // registro por tienda para la traza
      for (const t of TIENDAS) {
        const mapa = CATEGORY_MAP_CO[t.slug]?.[cat.slug];
        try {
          if (mapa) {
            const items0 = await fetchPorCategoriaCO(t.slug, cat.slug);
            if (!items0) { pasos.push({ tienda: t.slug, metodo: "arbol", detalle: mapa.paths.join(", "), shared: !!mapa.shared, crudos: 0, tras_filtro: 0, aportados: 0, nota: "sin datos" }); continue; }
            const filtrados = !mapa.shared ? items0 : items0.filter((it: any) => terminosIncl.some((term: string) => sinAcentos((it.nombre ?? "").toLowerCase()).includes(term)));
            found.push(...filtrados);
            pasos.push({ tienda: t.slug, metodo: "arbol", detalle: mapa.paths.join(", "), shared: !!mapa.shared, crudos: items0.length, tras_filtro: filtrados.length, aportados: 0 });
          } else {
            const kw: any[] = [];
            for (const term of cat.terminos) kw.push(...(await fetchVtexCO(t, term).catch(() => [])));
            found.push(...kw);
            pasos.push({ tienda: t.slug, metodo: "palabra", detalle: (cat.terminos ?? []).join(", "), shared: false, crudos: kw.length, tras_filtro: kw.length, aportados: 0 });
          }
        } catch { pasos.push({ tienda: t.slug, metodo: "error", detalle: "", shared: false, crudos: 0, tras_filtro: 0, aportados: 0 }); }
      }
      const makro = (await Promise.all(cat.terminos.map((term: string) => fetchMakro(term).catch(() => [])))).flat();
      found.push(...makro);
      pasos.push({ tienda: "makro", metodo: "palabra", detalle: (cat.terminos ?? []).join(", "), shared: false, crudos: makro.length, tras_filtro: makro.length, aportados: 0 });
      let added = 0, nExcl = 0, nDedup = 0; const aportPorTienda: Record<string, number> = {};
      for (const it of found) {
        const nm = (it.nombre ?? "").toLowerCase();
        if (excl.some((e: string) => nm.includes(e))) { nExcl++; continue; }
        const k = it.retailer + "|" + it.product_id;
        if (seen.has(k)) { nDedup++; continue; } seen.add(k);
        it.categoria = cat.slug; items.push(it); added++;
        porTienda[it.retailer] = (porTienda[it.retailer] || 0) + 1;
        aportPorTienda[it.retailer] = (aportPorTienda[it.retailer] || 0) + 1;
      }
      porCat[cat.slug] = added;
      for (const p of pasos) p.aportados = aportPorTienda[p.tienda] || 0;
      traza.push({ slug: cat.slug, nombre: cat.nombre ?? cat.slug, terminos: cat.terminos ?? [], excluir: cat.excluir ?? [], aportados_total: added, excluidos: nExcl, duplicados: nDedup, pasos });
    }
    if (explain) return new Response(JSON.stringify({ ok: true, pais: "CO", modo: "explain", traza, tiendas: [...TIENDAS.map((t) => t.slug), "makro"], scrapeados: items.length, ms: Date.now() - t0 }), { headers: CORS });
    const guardados = items.length ? await rpc("dealbot_upsert_batch", { items }) : 0;
    return new Response(JSON.stringify({ ok: true, pais: "CO", porCategoria: porCat, porTienda, scrapeados: items.length, guardados, ms: Date.now() - t0 }), { headers: CORS });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: CORS });
  }
});
