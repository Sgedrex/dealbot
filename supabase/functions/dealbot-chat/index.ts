import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// ===== DealBot Chat — asistente sobre TODOS los precios (todas las categorias + mayoristas) =====
// El chatbot usa Haiku 4.5 (rapido/barato). Cambiable a Opus por el secret CHAT_MODEL.
// La API key vive en el secret ANTHROPIC_API_KEY (nunca en el frontend ni en el repo).
const MODEL = Deno.env.get("CHAT_MODEL") || "claude-haiku-4-5";
const MAX_TOKENS = 450;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const TN: Record<string, string> = { superxtra: "SuperXtra", superrey: "Super Rey", super99: "Super99", supercarnes: "SuperCarnes", superbaru: "Super Baru", machetazo: "El Machetazo", msmega: "MsMega" };
const CATN: Record<string, string> = { atun: "Atun", sardinas: "Sardinas", vegetales_enlatados: "Vegetales enlatados", cafe: "Cafe", arroz: "Arroz" };

function json(obj: unknown) { return new Response(JSON.stringify(obj), { headers: { ...CORS, "content-type": "application/json" } }); }
function precios(c: any) {
  return [["SuperXtra", c.precio_xtra], ["Super Rey", c.precio_rey], ["Super99", c.precio_99], ["SuperCarnes", c.precio_carnes], ["Super Baru", c.precio_baru], ["El Machetazo", c.precio_mach]]
    .filter(([, p]) => p).map(([t, p]) => `${t} $${p}`).join(", ");
}

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
    const catActual = ((body.categoria ?? "").toString().toLowerCase().replace(/[^a-z_]/g, "").slice(0, 40));
    const modo = (body.modo ?? "").toString() === "negocio" ? "negocio" : "consumidor";

    const h = { apikey: SB_KEY, authorization: `Bearer ${SB_KEY}` };
    const [rankRes, compRes, mayRes] = await Promise.all([
      fetch(`${SB_URL}/rest/v1/dealbot_ranking?select=categoria,retailer,veces_mas_barata,productos,indice_precio`, { headers: h }),
      fetch(`${SB_URL}/rest/v1/dealbot_comparador?select=categoria,nombre,marca,tienda_mas_barata,ahorro_pct,precio_xtra,precio_rey,precio_99,precio_carnes,precio_baru,precio_mach&order=ahorro_pct.desc.nullslast&limit=300`, { headers: h }),
      fetch(`${SB_URL}/rest/v1/dealbot_deals_actuales?retailer=eq.msmega&select=categoria,nombre,marca,price&limit=45`, { headers: h }),
    ]);
    const rank = await rankRes.json().catch(() => []);
    const comp = await compRes.json().catch(() => []);
    const may = await mayRes.json().catch(() => []);

    // Ranking por categoria
    const rankByCat: Record<string, any[]> = {};
    (Array.isArray(rank) ? rank : []).forEach((r: any) => { (rankByCat[r.categoria] ??= []).push(r); });
    // Top 6 comparables por categoria (ya vienen ordenados por ahorro desc)
    const compByCat: Record<string, any[]> = {};
    (Array.isArray(comp) ? comp : []).forEach((c: any) => { if (!c.ahorro_pct) return; const a = (compByCat[c.categoria] ??= []); if (a.length < 6) a.push(c); });

    const cats = [...new Set([...Object.keys(rankByCat), ...Object.keys(compByCat)])].sort();
    let datos = "";
    for (const cat of cats) {
      const rk = (rankByCat[cat] || []).sort((a: any, b: any) => Number(a.indice_precio) - Number(b.indice_precio))
        .map((r: any) => `${TN[r.retailer] || r.retailer} ${r.veces_mas_barata}/${r.productos}`).join(", ");
      const filas = (compByCat[cat] || []).map((c: any) => `- ${c.nombre} (${c.marca || "s/m"}): ${precios(c)} | mas barato ${c.tienda_mas_barata}, ahorro ${Math.round(Number(c.ahorro_pct))}%`).join("\n");
      datos += `\n## ${CATN[cat] || cat}\nRanking (mas barata primero): ${rk || "sin datos"}\n${filas || "sin comparables"}\n`;
    }
    if (Array.isArray(may) && may.length) {
      const m = may.map((x: any) => `- ${x.nombre} (${x.marca || "s/m"}) [${CATN[x.categoria] || x.categoria}]: MsMega $${x.price}`).join("\n");
      datos += `\n## Mayoristas (packs, tienda MsMega — no comparar por unidad con retail)\n${m}\n`;
    }

    const verCat = catActual ? `El usuario esta viendo la categoria "${CATN[catActual] || catActual}", pero podes responder de cualquiera.` : "";
    const tono = modo === "negocio"
      ? "PERFIL DEL USUARIO: tiene un negocio o marca. Responde como analista de inteligencia comercial: menciona competencia, ranking de tiendas, variacion y posicionamiento de la marca, y cierra con una conclusion ejecutiva accionable."
      : "PERFIL DEL USUARIO: es un consumidor que quiere ahorrar. Responde simple y cercano: di claramente donde comprar y cuanto ahorra, sin jerga tecnica (evita palabras como indice, ponderado o comparables).";
    const system = `Sos el asistente de DealBot PA, plataforma de inteligencia de precios de supermercados de Panama. Tenes los datos de TODAS las categorias (atun, sardinas, vegetales enlatados, cafe, arroz) y de los mayoristas; responde sobre cualquiera de ellas. ${verCat} ${tono} Responde en espanol, breve y directo (maximo 4 frases), citando tiendas y precios reales. No inventes datos ni precios: si algo no esta en los datos, deci que no tenes ese producto registrado. Responde directo, sin mostrar tu razonamiento.\n\n=== DATOS DE PRECIOS ===${datos}`;

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
