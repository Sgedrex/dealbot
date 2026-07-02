# Integración Riba Smith — checklist de go-live

Fetcher **construido y probado** contra la API real (Magento GraphQL, `sku` = EAN).
Falta desplegar el backend + sumar la columna al frontend. **Bloqueado hasta reconectar Supabase.**

## Estado
- [x] `fetchRibaSmith` en `supabase/functions/dealbot-scan/index.ts` (+ FETCHERS + tiendaNombre) — commiteado, sin desplegar
- [x] Migración de la vista en `supabase/migrations/add_ribasmith_to_comparador.sql` — sin aplicar
- [ ] Desplegar scraper (Supabase)
- [ ] Aplicar migración de la vista (Supabase)
- [ ] Correr el scan 1 vez
- [ ] Frontend: columna Riba Smith
- [ ] Validar precios contra la web

## Pasos al reconectar Supabase
1. **Desplegar** `dealbot-scan` (queda con fetchRibaSmith).
2. **Correr el scan** (`POST /functions/v1/dealbot-scan`) para poblar `retailer='ribasmith'`.
3. **Aplicar** `add_ribasmith_to_comparador.sql` (recrea la vista con `precio_riba`).
4. **Frontend** (`index.html`): sumar la 7.ª columna retail:
   - Tabla `#view-comp`: nuevo `<th>Riba Smith</th>` + `cell(d.precio_riba,best,"Riba Smith",d.link_riba,d.nombre_riba)`.
   - `tiendaNombre`: `ribasmith:'Riba Smith'`.
   - `chipClass` y `COLORS`: color para `ribasmith`.
   - `TIENDAS_CAMPO` (simulador) y el array de tiendas de la canasta: `['ribasmith','precio_riba']`.
   - `nRetailCount`: incluir `d.precio_riba`.
   - Cobertura por tienda / export Excel-PDF: incluir la columna.
5. **Edge Function `dealbot-chat`**: en `precios()` y los `select` del comparador sumar `precio_riba` / "Riba Smith".
6. **Validar**: abrir 3-4 productos y comparar el precio del panel con la web de Riba Smith.

## Notas
- `sku` de Riba Smith = código de barras → empareja directo por EAN con las otras tiendas.
- Ojo con productos por peso (frescos): aplicar la misma lógica de `unit`/kg que en Super Rey si aparecen precios inflados.
