import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// ===== DealBot Chat — asistente de precios multi-país (PA/CO) =====
// Haiku 4.5 (rápido/barato). Personalidad por modo + contexto de la marca del usuario.
const MODEL = Deno.env.get("CHAT_MODEL") || "claude-haiku-4-5";
const MAX_TOKENS = 450;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const CONF: Record<string, any> = {
  PA: {
    moneda: "dólares (USD)",
    rank: "dealbot_ranking", comp: "dealbot_comparador", may: "dealbot_deals_actuales",
    tn: { superxtra: "SuperXtra", superrey: "Super Rey", super99: "Super99", supercarnes: "SuperCarnes", superbaru: "Super Baru", machetazo: "El Machetazo", msmega: "MsMega", ribasmith: "Riba Smith" },
    campos: [["SuperXtra","precio_xtra"],["Super Rey","precio_rey"],["Super99","precio_99"],["SuperCarnes","precio_carnes"],["Super Baru","precio_baru"],["El Machetazo","precio_mach"],["Riba Smith","precio_riba"]],
    pais: "Panama",
  },
  CO: {
    moneda: "pesos colombianos (COP)",
    rank: "dealbot_ranking_co", comp: "dealbot_comparador_co", may: null,
    tn: { exito: "Éxito", carulla: "Carulla", jumbo: "Jumbo", olimpica: "Olímpica" },
    campos: [["Éxito","precio_exito"],["Carulla","precio_carulla"],["Jumbo","precio_jumbo"],["Olímpica","precio_olimpica"]],
    pais: "Colombia",
  },
};
const CATN: Record<string, string> = { atun: "Atun", sardinas: "Sardinas", vegetales_enlatados: "Vegetales enlatados", cafe: "Cafe", arroz: "Arroz", duraznos: "Duraznos", aceite_cocina: "Aceite", pasta: "Pasta", leche: "Leche" };

function json(obj: unknown) { return new Response(JSON.stringify(obj), { headers: { ...CORS, "content-type": "application/json" } }); }

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const body = await req.json().catch(() => ({}));
    const pregunta = (body.pregunta ?? "").toString().trim();
    if (!pregunta) return json({ texto: "Escribime una pregunta sobre los precios." });
    if (pregunta.length > 300) return json({ texto: "Tu pregunta es muy larga (max 300 caracteres)." });

    const KEY = Deno.env.get("ANTHROPIC_API_KEY");
    if (!KEY) return json({ texto: "El chat aun no esta configurado (falta cargar la API key en Supabase).", sinKey: true });

    const SB_URL = Deno.env.get("SUPABASE_URL")!;
    const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const P = CONF[(body.pais ?? "").toString() === "CO" ? "CO" : "PA"];
    const catActual = ((body.categoria ?? "").toString().toLowerCase().replace(/[^a-z_]/g, "").slice(0, 40));
    const modo = (body.modo ?? "").toString() === "negocio" ? "negocio" : "consumidor";
    const marca = (body.marca ?? "").toString().slice(0, 80);
    const precios = (c: any) => P.campos.filter(([, f]: any) => c[f]).map(([t, f]: any) => `${t} $${c[f]}`).join(", ");

    const h = { apikey: SB_KEY, authorization: `Bearer ${SB_KEY}` };
    const compSel = "categoria,nombre,marca,tienda_mas_barata,ahorro_pct," + P.campos.map(([, f]: any) => f).join(",");
    const [rankRes, compRes, mayRes] = await Promise.all([
      fetch(`${SB_URL}/rest/v1/${P.rank}?select=categoria,retailer,veces_mas_barata,productos,indice_precio`, { headers: h }),
      fetch(`${SB_URL}/rest/v1/${P.comp}?select=${compSel}&order=ahorro_pct.desc.nullslast&limit=300`, { headers: h }),
      P.may ? fetch(`${SB_URL}/rest/v1/${P.may}?retailer=eq.msmega&select=categoria,nombre,marca,price&limit=45`, { headers: h }) : Promise.resolve(null),
    ]);
    const rank = await rankRes.json().catch(() => []);
    const comp = await compRes.json().catch(() => []);
    const may = mayRes ? await mayRes.json().catch(() => []) : [];

    const rankByCat: Record<string, any[]> = {};
    (Array.isArray(rank) ? rank : []).forEach((r: any) => { (rankByCat[r.categoria] ??= []).push(r); });
    const compByCat: Record<string, any[]> = {};
    (Array.isArray(comp) ? comp : []).forEach((c: any) => { if (!c.ahorro_pct) return; const a = (compByCat[c.categoria] ??= []); if (a.length < 6) a.push(c); });

    const cats = [...new Set([...Object.keys(rankByCat), ...Object.keys(compByCat)])].sort();
    let datos = "";
    for (const cat of cats) {
      const rk = (rankByCat[cat] || []).sort((a: any, b: any) => Number(a.indice_precio) - Number(b.indice_precio))
        .map((r: any) => `${P.tn[r.retailer] || r.retailer} ${r.veces_mas_barata}/${r.productos}`).join(", ");
      const filas = (compByCat[cat] || []).map((c: any) => `- ${c.nombre} (${c.marca || "s/m"}): ${precios(c)} | mas barato ${c.tienda_mas_barata}, ahorro ${Math.round(Number(c.ahorro_pct))}%`).join("\n");
      datos += `\n## ${CATN[cat] || cat}\nRanking (mas barata primero): ${rk || "sin datos"}\n${filas || "sin comparables"}\n`;
    }
    if (Array.isArray(may) && may.length) {
      const m = may.map((x: any) => `- ${x.nombre} (${x.marca || "s/m"}) [${CATN[x.categoria] || x.categoria}]: MsMega $${x.price}`).join("\n");
      datos += `\n## Mayoristas (packs, tienda MsMega — no comparar por unidad con retail)\n${m}\n`;
    }

    let marcaCtx = "", marcaDatos = "";
    if (marca) {
      const generic = ["cafe", "atun", "arroz", "sardina", "sardinas", "vegetales", "enlatados", "aceite", "pasta", "de", "la", "el", "los", "las", "marca", "mi"];
      const palabras = marca.toLowerCase().split(/\s+/).filter((w) => w.length > 2 && !generic.includes(w));
      const term = palabras[0] || marca;
      try {
        const mr = await fetch(`${SB_URL}/rest/v1/${P.comp}?select=nombre,tienda_mas_barata,${P.campos.map(([, f]: any) => f).join(",")}&nombre=ilike.*${encodeURIComponent(term)}*&limit=25`, { headers: h });
        const filas = await mr.json().catch(() => []);
        if (Array.isArray(filas) && filas.length) {
          marcaDatos = `\n=== PRODUCTOS DE TU MARCA (${marca}) ===\n` + filas.map((c: any) => `- ${c.nombre}: ${precios(c)} | mas barato en ${c.tienda_mas_barata}`).join("\n");
        }
      } catch (_e) { /* ignore */ }
      marcaCtx = `La marca o negocio del usuario es "${marca}". Cuando pregunte "donde estoy mas caro o barato", "como me posiciono", "mi marca" o similar, se refiere a ${marca}: usa los PRODUCTOS DE TU MARCA de abajo. NO le preguntes que marca vende. Si no hay productos de su marca en los datos, decilo claramente.`;
    }
    const verCat = catActual ? `El usuario esta viendo la categoria "${CATN[catActual] || catActual}", pero podes responder de cualquiera.` : "";
    const tono = modo === "negocio"
      ? "PERFIL DEL USUARIO: tiene un negocio o marca. Responde como analista de inteligencia comercial: competencia, ranking de tiendas, posicionamiento, y cierra con una conclusion ejecutiva accionable."
      : "PERFIL DEL USUARIO: es un consumidor que quiere ahorrar. Responde simple y cercano: di donde comprar y cuanto ahorra, sin jerga tecnica.";
    const system = `Sos el asistente de DealBot ${P.pais === "Colombia" ? "CO" : "PA"}, plataforma de inteligencia de precios de supermercados de ${P.pais}. Los precios estan en ${P.moneda}. Tenes los datos de todas las categorias monitoreadas; responde sobre cualquiera. ${verCat} ${tono} ${marcaCtx} Responde en espanol, breve y directo (maximo 4 frases), citando tiendas y precios reales. No inventes datos ni precios: si algo no esta en los datos, deci que no lo tenes registrado. Responde directo, sin mostrar tu razonamiento.\n\n=== DATOS DE PRECIOS ===${datos}${marcaDatos}`;

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: MAX_TOKENS, system, messages: [{ role: "user", content: pregunta }] }),
    });
    const j = await r.json();
    if (!r.ok) return json({ texto: "Servicio no disponible: " + (j?.error?.message || r.status) });
    if (j.stop_reason === "refusal" || !Array.isArray(j.content)) return json({ texto: "No puedo responder eso. Proba preguntando por precios de productos." });
    const texto = (j.content.find((b: any) => b.type === "text")?.text) || "No tengo una respuesta para eso.";
    const usage = j.usage ? { in: j.usage.input_tokens, out: j.usage.output_tokens } : null;
    return json({ texto, usage, modelo: MODEL });
  } catch (e) {
    return json({ texto: "Error: " + ((e as Error)?.message || e) });
  }
});
