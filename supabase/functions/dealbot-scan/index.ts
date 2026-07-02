import "jsr:@supabase/functions-js/edge-runtime.d.ts";
// DealBot — Edge Function: scrapea las 7 tiendas, guarda precios, detecta caidas y avisa por Telegram.
// Disponibilidad: VTEX expone AvailableQuantity/IsAvailable y Rey isAvailable/stock -> se marca 'disponible'
// para que el upsert ponga activo=false en agotados (no aparecen como "mas barato" fantasma).

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// Secrets en Supabase (Edge Functions > Secrets): NUNCA hardcodear en el repo
const TG_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") || "";
const TG_CHAT  = Deno.env.get("TELEGRAM_CHAT_ID") || "";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";
const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "POST, GET, OPTIONS", "access-control-allow-headers": "*", "content-type": "application/json" };

const REY_ENDPOINT = "https://nextgentheadless.instaleap.io/api/v3";
const REY_HEADERS = { "content-type": "application/json", "dpl-api-key": "62cdb0f8-0367-4dee-88fb-134097d9d42e", "apollographql-client-name": "e-commerce Moira Engine client GRUPO_REY", "apollographql-client-version": "0.19.199" };
const S99_ENDPOINT = "https://catalog-service.adobe.io/graphql";
const S99_HEADERS = { "content-type": "application/json", "x-api-key": "da886b56118447a0a59703de747349ad", "magento-environment-id": "62e34917-8244-4ca2-869c-5c4958a4ec04", "magento-website-code": "super99", "magento-store-code": "super99", "magento-store-view-code": "brisas_del_golf", "magento-customer-group": "", "origin": "https://www.super99.com", "referer": "https://www.super99.com/" };
const S99_QUERY = `query S($phrase: String!, $pageSize: Int, $currentPage: Int, $filter: [SearchClauseInput!], $context: QueryContextInput) { productSearch(phrase: $phrase, page_size: $pageSize, current_page: $currentPage, filter: $filter, context: $context) { items { product { sku name price_range { minimum_price { regular_price { value } final_price { value } } } } productView { attributes { name value } } } } }`;

function tiendaNombre(r: string) {
  const m: any = { superxtra: "SuperXtra", superrey: "Super Rey", msmega: "MsMega", super99: "Super99", supercarnes: "SuperCarnes", superbaru: "Super Barú", machetazo: "El Machetazo", ribasmith: "Riba Smith" };
  return m[r] ?? r;
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// VTEX (SuperXtra, Machetazo): commertialOffer.AvailableQuantity = 0 / IsAvailable false -> agotado.
function mapVtex(arr: any[], retailer: string, dominio: string) {
  return arr.map((p: any) => { const item = p.items?.[0] ?? {}; const offer = item.sellers?.[0]?.commertialOffer ?? {}; return { retailer, product_id: String(p.productId), ean: item.ean ?? "", nombre: p.productName ?? "", marca: p.brand ?? "", link: `https://${dominio}/${p.linkText}/p`, price: Number(offer.Price ?? 0), list_price: offer.ListPrice != null ? String(offer.ListPrice) : "", disponible: Number(offer.AvailableQuantity ?? 0) > 0 && offer.IsAvailable !== false }; }).filter((x: any) => x.price > 0);
}

async function fetchXtra(term: string) {
  const res = await fetch(`https://www.superxtra.com/api/catalog_system/pub/products/search?ft=${encodeURIComponent(term)}&_from=0&_to=49`, { headers: { accept: "application/json", "user-agent": UA } });
  if (!res.ok) return [];
  return mapVtex(await res.json(), "superxtra", "www.superxtra.com");
}

async function fetchMachetazo(term: string) {
  const res = await fetch(`https://www.elmachetazo.com/api/catalog_system/pub/products/search?ft=${encodeURIComponent(term)}&_from=0&_to=49`, { headers: { accept: "application/json", "user-agent": UA } });
  if (!res.ok) return [];
  return mapVtex(await res.json(), "machetazo", "www.elmachetazo.com");
}

// gramos extraidos del nombre (para convertir precio por kg -> precio del paquete)
function gramosDe(n: string): number | null {
  if (!n) return null; const s = ("" + n).toLowerCase(); let m;
  if ((m = s.match(/(\d+(?:[.,]\d+)?)\s*kg/))) return parseFloat(m[1].replace(",", ".")) * 1000;
  if ((m = s.match(/(\d+(?:[.,]\d+)?)\s*gr?s?\b/))) return parseFloat(m[1].replace(",", "."));
  return null;
}
async function fetchRey(term: string) {
  const body = [{ operationName: "SearchProducts", variables: { searchProductsInput: { clientId: "GRUPO_REY", storeReference: "1038", currentPage: 1, pageSize: 50, search: { query: term } } }, query: "query SearchProducts($searchProductsInput: SearchProductsInput!) { searchProducts(searchProductsInput: $searchProductsInput) { products { sku name price stock isAvailable unit } } }" }];
  const res = await fetch(REY_ENDPOINT, { method: "POST", headers: REY_HEADERS, body: JSON.stringify(body) });
  if (!res.ok) return [];
  const json = await res.json();
  const prods = json?.[0]?.data?.searchProducts?.products ?? json?.data?.searchProducts?.products ?? [];
  return prods.map((p: any) => {
    let price = Number(p.price ?? 0);
    let disp = p.isAvailable !== false && Number(p.stock ?? 1) > 0;
    // unit "kg" => price es POR KILO. Convertir al precio del paquete con el peso del nombre; si es granel sin peso, desactivar.
    if (p.unit && /kg/i.test(String(p.unit))) {
      const g = gramosDe(p.name ?? "");
      if (g) price = Math.round(price * g / 1000 * 100) / 100;
      else disp = false;
    }
    return { retailer: "superrey", product_id: String(p.sku), ean: String(p.sku), nombre: p.name ?? "", marca: "", link: `https://www.smrey.com/search?name=${encodeURIComponent(p.name ?? "")}`, price, list_price: "", disponible: disp };
  }).filter((x: any) => x.price > 0);
}

async function fetchMsMega(term: string) {
  const re = /codig=(\d+)[\s\S]*?color: RED; text-align: right;'>\$([0-9.]+)[\s\S]*?color: brown[^>]*>([^<]+)<\/td>/g;
  const seen = new Set<string>(); const out: any[] = [];
  const variants = Array.from(new Set([term.toLowerCase(), cap(term.toLowerCase())]));
  for (const t of variants) {
    const res = await fetch(`https://distlong.com/msmega/catalogo.php?lang=ES&pages=0&cinfo=${encodeURIComponent(t)}&grupo=&marca=`, { headers: { "user-agent": UA } });
    if (!res.ok) continue;
    const html = await res.text(); let m: RegExpExecArray | null; re.lastIndex = 0;
    while ((m = re.exec(html)) !== null) { const codig = m[1]; if (seen.has(codig)) continue; seen.add(codig); out.push({ retailer: "msmega", product_id: codig, ean: codig, nombre: m[3].trim(), marca: "", link: `https://distlong.com/msmega/catalogo.php?lang=ES&cinfo=${encodeURIComponent(m[3].trim())}`, price: Number(m[2]), list_price: "" }); }
  }
  return out.filter((x) => x.price > 0);
}

async function fetchSuper99(term: string) {
  const ctx = { customerGroup: "b6589fc6ab0dc82cf12099d1c2d40ab994e8410c", userViewHistory: [] };
  const filter = [{ attribute: "visibility", in: ["Search", "Catalog, Search"] }];
  const seen = new Set<string>(); const out: any[] = [];
  for (let pg = 1; pg <= 5; pg++) {
    const body = { query: S99_QUERY, variables: { phrase: term, pageSize: 48, currentPage: pg, filter, context: ctx } };
    const res = await fetch(S99_ENDPOINT, { method: "POST", headers: S99_HEADERS, body: JSON.stringify(body) });
    if (!res.ok) break;
    const json = await res.json(); const items = json?.data?.productSearch?.items ?? [];
    if (!items.length) break;
    for (const it of items) { const sku = it.product?.sku; if (!sku || seen.has(sku)) continue; seen.add(sku); const attrs = it.productView?.attributes ?? []; const upc = attrs.find((a: any) => a.name === "upc")?.value ?? ""; const marca = attrs.find((a: any) => a.name === "marca")?.value ?? ""; const mp = it.product?.price_range?.minimum_price ?? {}; out.push({ retailer: "super99", product_id: String(sku), ean: String(upc), nombre: it.product?.name ?? "", marca: String(marca), link: `https://www.super99.com/catalogsearch/result/?q=${encodeURIComponent(it.product?.name ?? "")}`, price: Number(mp.final_price?.value ?? 0), list_price: mp.regular_price?.value ? String(mp.regular_price.value) : "" }); }
    if (items.length < 48) break;
  }
  return out.filter((x) => x.price > 0);
}

async function fetchSuperCarnes(term: string) {
  const res = await fetch(`https://supercarnes.com/albrook/catalogsearch/result/?q=${encodeURIComponent(term)}`, { headers: { "user-agent": UA } });
  if (!res.ok) return [];
  const html = await res.text(); const chunks = html.split("product-item-info"); const seen = new Set<string>(); const out: any[] = [];
  for (const ch of chunks) { const nm = ch.match(/product-item-link"[^>]*>\s*([^<]+?)\s*</); const sku = ch.match(/"sku":"(\d{6,14})"/); const pr = ch.match(/data-price-amount="([0-9.]+)"/); if (!nm || !pr) continue; const ean = sku ? sku[1] : ""; const pid = ean || nm[1].trim(); if (seen.has(pid)) continue; seen.add(pid); out.push({ retailer: "supercarnes", product_id: pid, ean, nombre: nm[1].trim(), marca: "", link: `https://supercarnes.com/albrook/catalogsearch/result/?q=${encodeURIComponent(nm[1].trim())}`, price: Number(pr[1]), list_price: "" }); }
  return out.filter((x) => x.price > 0);
}

async function fetchSuperBaru(term: string) {
  const res = await fetch(`https://superbaru.com/search/suggest.json?q=${encodeURIComponent(term)}&resources[type]=product&resources[limit]=10`, { headers: { "user-agent": UA, accept: "application/json" } });
  if (!res.ok) return [];
  const json = await res.json(); const prods = json?.resources?.results?.products ?? [];
  const results = await Promise.all(prods.map(async (p: any) => { let ean = "", list = ""; try { const pj = await fetch(`https://superbaru.com/products/${p.handle}.json`, { headers: { "user-agent": UA } }); if (pj.ok) { const d = await pj.json(); const v = d.product?.variants?.[0] ?? {}; ean = v.barcode ?? ""; list = v.compare_at_price ?? ""; } } catch { /* ignore */ } return { retailer: "superbaru", product_id: String(p.id), ean: String(ean ?? ""), nombre: p.title ?? "", marca: p.vendor ?? "", link: `https://superbaru.com${p.url}`, price: Number(p.price), list_price: list ? String(list) : "" }; }));
  return results.filter((x: any) => x.price > 0);
}

// Riba Smith (premium): Magento GraphQL. El sku es el EAN-13 SIN digito verificador (12 digitos);
// se recalcula el check digit para reconstruir el EAN-13 y emparejar con las otras tiendas.
function ean13(d: string): string {
  if (!/^\d{12}$/.test(d)) return d;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += (+d[i]) * (i % 2 === 0 ? 1 : 3);
  return d + String((10 - (sum % 10)) % 10);
}
async function fetchRibaSmith(term: string) {
  const query = "query S($s:String!,$pg:Int!){ products(search:$s, pageSize:50, currentPage:$pg){ items { name sku price_range { minimum_price { final_price { value } regular_price { value } } } } } }";
  const seen = new Set<string>(); const out: any[] = [];
  for (let pg = 1; pg <= 4; pg++) {
    const res = await fetch("https://www.ribasmith.com/graphql", { method: "POST", headers: { "content-type": "application/json", "user-agent": UA }, body: JSON.stringify({ query, variables: { s: term, pg } }) });
    if (!res.ok) break;
    const json = await res.json();
    const items = json?.data?.products?.items ?? [];
    if (!items.length) break;
    for (const p of items) { const sku = String(p.sku ?? ""); if (!sku || seen.has(sku)) continue; seen.add(sku); const mp = p.price_range?.minimum_price ?? {}; out.push({ retailer: "ribasmith", product_id: sku, ean: ean13(sku), nombre: p.name ?? "", marca: "", link: `https://www.ribasmith.com/catalogsearch/result/?q=${encodeURIComponent(p.name ?? "")}`, price: Number(mp.final_price?.value ?? 0), list_price: mp.regular_price?.value ? String(mp.regular_price.value) : "" }); }
    if (items.length < 50) break;
  }
  return out.filter((x) => x.price > 0);
}

const FETCHERS = [fetchXtra, fetchMachetazo, fetchRey, fetchMsMega, fetchSuper99, fetchSuperCarnes, fetchSuperBaru, fetchRibaSmith];

async function rpc(fn: string, args: any) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, { method: "POST", headers: { "content-type": "application/json", apikey: SERVICE_KEY, authorization: `Bearer ${SERVICE_KEY}` }, body: JSON.stringify(args) });
  if (!res.ok) throw new Error(`rpc ${fn} ${res.status}: ${await res.text()}`);
  return await res.json();
}
async function getCategorias() {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/dealbot_categorias?activo=eq.true&select=slug,terminos,excluir&order=orden`, { headers: { apikey: SERVICE_KEY, authorization: `Bearer ${SERVICE_KEY}` } });
  return res.ok ? await res.json() : [];
}
async function insertAlerta(a: any) { await fetch(`${SUPABASE_URL}/rest/v1/dealbot_alertas`, { method: "POST", headers: { "content-type": "application/json", apikey: SERVICE_KEY, authorization: `Bearer ${SERVICE_KEY}`, prefer: "return=minimal" }, body: JSON.stringify({ producto_id: a.producto_id, price: a.price, list_price: a.list_price, caida_pct: a.desc_pct, motivo: a.motivo }) }); }
async function sendTelegram(text: string) { if (!TG_TOKEN || !TG_CHAT) return; await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: "HTML", disable_web_page_preview: true }) }); }

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const t0 = Date.now();
  try {
    const cats = await getCategorias();
    if (!cats.length) return new Response(JSON.stringify({ ok: false, error: "sin categorias" }), { status: 400, headers: CORS });
    const seen = new Set<string>(); const items: any[] = []; const porCat: any = {};
    for (const cat of cats) {
      const excl = (cat.excluir ?? []).map((e: string) => e.toLowerCase());
      const tasks: Promise<any[]>[] = [];
      for (const term of cat.terminos) for (const f of FETCHERS) tasks.push(f(term).catch(() => []));
      const found = (await Promise.all(tasks)).flat();
      let added = 0;
      for (const it of found) {
        const nm = (it.nombre ?? "").toLowerCase();
        if (excl.some((e: string) => nm.includes(e))) continue;
        const k = it.retailer + "|" + it.product_id;
        if (seen.has(k)) continue; seen.add(k);
        it.categoria = cat.slug; items.push(it); added++;
      }
      porCat[cat.slug] = added;
    }
    const guardados = items.length ? await rpc("dealbot_upsert_batch", { items }) : 0;
    const deals: any[] = await rpc("dealbot_deals_para_alertar", {});
    let alertados = 0;
    if (deals.length) {
      const top = deals.sort((a, b) => Number(b.desc_pct) - Number(a.desc_pct)).slice(0, 10);
      const lineas = top.map((d, i) => { const was = d.list_price && Number(d.list_price) > Number(d.price) ? ` (antes $${Number(d.list_price).toFixed(2)})` : ""; return `${i + 1}️⃣ <b>${d.nombre}</b>\n   ${tiendaNombre(d.retailer)} → <b>$${Number(d.price).toFixed(2)}</b>${was} ↓${Number(d.desc_pct).toFixed(1)}%`; }).join("\n\n");
      await sendTelegram(`🔥 <b>DealBot · Caídas de precio</b>\n\n${lineas}\n\n📊 https://dealbot-atun.vercel.app`);
      for (const d of top) { await insertAlerta(d); alertados++; }
    }
    return new Response(JSON.stringify({ ok: true, porCategoria: porCat, scrapeados: items.length, guardados, deals_detectados: deals.length, alertados, ms: Date.now() - t0 }), { headers: CORS });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: CORS });
  }
});
