# 🛒 DealBot — Inteligencia de precios de supermercados

Monitoreo y comparación de precios de abarrotes entre supermercados, en **dos países**. Scrapea las tiendas, empareja productos por **código de barras (EAN)**, detecta caídas de precio, arma inteligencia de marca y avisa por Telegram.

🌐 **Dashboards en vivo:**
- 🇵🇦 Panamá — https://dealbot-panama.vercel.app
- 🇨🇴 Colombia — https://dealbot-colombia.vercel.app

---

## ✨ Funciones

- **Comparador retail** — el mismo producto (por EAN) lado a lado en las tiendas, con la más barata y el % de ahorro.
- **Catálogo** y **Mayoristas** — listas separadas (los packs mayoristas no se mezclan con unidades).
- **Filtros** — por categoría, marca, presentación y buscador por nombre o SKU; filtros tipo Excel por columna.
- **🏆 Ranking de tiendas** — qué tienda es más barata en promedio por categoría.
- **🎯 Panel de marca** — cómo se posiciona tu marca frente a la competencia (KPIs, ranking, cobertura por tienda).
- **🧺 Canasta básica** — armás una lista y te dice dónde sale más barato comprar todo junto.
- **📈 Histórico** — evolución del precio de cada producto por tienda (ventana rodante 7 días).
- **📉 Índice de precios** — promedio de la categoría en el tiempo.
- **💬 Asistente IA** — chat de precios (Haiku) en el dashboard y en Telegram, con conciencia de país.
- **🔔 Alertas Telegram** — avisa cuando un precio cae (conmutable en Configuración).
- **📥 Export** — Excel y PDF de la vista actual.
- **🔄 Actualización** — automática (cron 2×/día) o manual.

## 🏪 Tiendas integradas

**🇵🇦 Panamá** — Super99 (Adobe Commerce), SuperXtra y El Machetazo (VTEX), Super Rey (Instaleap), Riba Smith (Magento GraphQL), SuperCarnes (HTML), Super Barú (Shopify), MsMega (mayorista, HTML).

**🇨🇴 Colombia** — Éxito, Carulla, Jumbo, Olímpica (VTEX), Makro (Instaleap).

## 🧱 Arquitectura

```
pg_cron (2×/día) ─▶ Edge Functions en Supabase
                       ├─ dealbot-scan     → scrapea tiendas de Panamá  (pais=PA)
                       ├─ dealbot-scan-co  → scrapea tiendas de Colombia (pais=CO)
                       ├─ guarda precios (histórico) en Postgres
                       ├─ detecta caídas → Telegram
                       └─ vistas SQL por país: comparador(_co), ranking(_co), etc.
                              │
   Dashboard (HTML + supabase-js + Chart.js, en Vercel) ◀── lee las vistas (anon key)
```

- **Frontend:** un **solo** `index.html` **config-driven** — el país se resuelve en runtime por el hostname (`dealbot-panama` → PA, `dealbot-colombia` → CO) o `?pais=CO`. Un solo código, dos despliegues.
- **Backend:** Supabase (Postgres + Edge Functions + pg_cron). Dimensión `pais` en las tablas; vistas espejo `_co`. Emparejamiento por EAN; clasificación mayorista/retail; exclusiones manuales.
- **Notificaciones / asistente:** bot de Telegram (`dealbot-tg`) + chat IA (`dealbot-chat`).

## 📂 Estructura

```
index.html            # MAESTRO config-driven — se edita UNA vez (fuente de verdad)
deploy-all.ps1        # copia el maestro a pa/ y co/ y despliega ambos
pa/                   # deploy Panamá  → dealbot-panama.vercel.app  (index.html + logos/)
co/                   # deploy Colombia → dealbot-colombia.vercel.app (index.html + logos/)
supabase/functions/
  dealbot-scan/       # scraping Panamá + alertas
  dealbot-scan-co/    # scraping Colombia
  dealbot-chat/       # asistente IA (multi-país)
  dealbot-tg/         # webhook del bot de Telegram (multi-país)
  dealbot-onboard/    # onboarding IA (PA)
```

> El `index.html` de `pa/` y `co/` es una **copia idéntica** del maestro (lo genera `deploy-all.ps1`); lo único propio de cada carpeta son sus `logos/` y su enlace de Vercel. El esquema SQL (tablas `dealbot_*`, vistas y funciones) vive en el proyecto Supabase.

## ⚠️ Notas

- La **anon key** de Supabase en `index.html` es pública por diseño (solo lee vistas; RLS protege las tablas).
- El **token de Telegram** y la **service_role** viven solo en las Edge Functions / variables de entorno de Supabase — nunca en el repo.
