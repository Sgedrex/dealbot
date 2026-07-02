-- ============================================================================
-- Integración Riba Smith (retail premium) al comparador.
-- PENDIENTE: aplicar + TESTEAR al reconectar Supabase. Antes de aplicar, el
-- scraper (dealbot-scan con fetchRibaSmith) debe haber corrido al menos 1 vez
-- para que existan filas retailer='ribasmith'.
-- Fuente: Magento GraphQL https://www.ribasmith.com/graphql (sku = EAN).
-- ============================================================================

CREATE OR REPLACE VIEW dealbot_comparador AS
WITH ultimo AS (
  SELECT DISTINCT ON (pr.producto_id) pr.producto_id, pr.price, pr.capturado_at
  FROM dealbot_precios pr
  ORDER BY pr.producto_id, pr.capturado_at DESC
), prod_precio AS (
  SELECT p.retailer, p.nombre, p.categoria, p.link, u.price,
         NULLIF(ltrim(p.ean, '0'::text), ''::text) AS ean_key
  FROM dealbot_productos p
    JOIN ultimo u ON u.producto_id = p.id
  WHERE p.activo AND p.ean IS NOT NULL AND p.ean <> ''::text
    AND NOT (EXISTS (SELECT 1 FROM dealbot_exclusiones x
                     WHERE x.ean = NULLIF(ltrim(p.ean, '0'::text), ''::text)
                       AND x.retailer = p.retailer))
), por_ean AS (
  SELECT prod_precio.ean_key,
    max(prod_precio.categoria) AS categoria,
    COALESCE(
      max(prod_precio.nombre) FILTER (WHERE prod_precio.retailer = 'superxtra'::text),
      max(prod_precio.nombre) FILTER (WHERE prod_precio.retailer = 'machetazo'::text),
      max(prod_precio.nombre) FILTER (WHERE prod_precio.retailer = 'superrey'::text),
      max(prod_precio.nombre) FILTER (WHERE prod_precio.retailer = 'super99'::text),
      max(prod_precio.nombre) FILTER (WHERE prod_precio.retailer = 'ribasmith'::text),
      max(prod_precio.nombre) FILTER (WHERE prod_precio.retailer = 'supercarnes'::text),
      max(prod_precio.nombre) FILTER (WHERE prod_precio.retailer = 'superbaru'::text),
      max(prod_precio.nombre) FILTER (WHERE prod_precio.retailer = 'msmega'::text)) AS nombre,
    min(prod_precio.price) FILTER (WHERE prod_precio.retailer = 'superxtra'::text)  AS precio_xtra,
    min(prod_precio.price) FILTER (WHERE prod_precio.retailer = 'superrey'::text)   AS precio_rey,
    min(prod_precio.price) FILTER (WHERE prod_precio.retailer = 'super99'::text)    AS precio_99,
    min(prod_precio.price) FILTER (WHERE prod_precio.retailer = 'supercarnes'::text) AS precio_carnes,
    min(prod_precio.price) FILTER (WHERE prod_precio.retailer = 'superbaru'::text)  AS precio_baru,
    min(prod_precio.price) FILTER (WHERE prod_precio.retailer = 'machetazo'::text)  AS precio_mach,
    min(prod_precio.price) FILTER (WHERE prod_precio.retailer = 'ribasmith'::text)  AS precio_riba,
    min(prod_precio.price) FILTER (WHERE prod_precio.retailer = 'msmega'::text)     AS precio_msmega,
    max(prod_precio.link) FILTER (WHERE prod_precio.retailer = 'superxtra'::text)  AS link_xtra,
    max(prod_precio.link) FILTER (WHERE prod_precio.retailer = 'superrey'::text)   AS link_rey,
    max(prod_precio.link) FILTER (WHERE prod_precio.retailer = 'super99'::text)    AS link_99,
    max(prod_precio.link) FILTER (WHERE prod_precio.retailer = 'supercarnes'::text) AS link_carnes,
    max(prod_precio.link) FILTER (WHERE prod_precio.retailer = 'superbaru'::text)  AS link_baru,
    max(prod_precio.link) FILTER (WHERE prod_precio.retailer = 'machetazo'::text)  AS link_mach,
    max(prod_precio.link) FILTER (WHERE prod_precio.retailer = 'ribasmith'::text)  AS link_riba,
    max(prod_precio.link) FILTER (WHERE prod_precio.retailer = 'msmega'::text)     AS link_msmega,
    max(prod_precio.nombre) FILTER (WHERE prod_precio.retailer = 'superxtra'::text)  AS nombre_xtra,
    max(prod_precio.nombre) FILTER (WHERE prod_precio.retailer = 'superrey'::text)   AS nombre_rey,
    max(prod_precio.nombre) FILTER (WHERE prod_precio.retailer = 'super99'::text)    AS nombre_99,
    max(prod_precio.nombre) FILTER (WHERE prod_precio.retailer = 'supercarnes'::text) AS nombre_carnes,
    max(prod_precio.nombre) FILTER (WHERE prod_precio.retailer = 'superbaru'::text)  AS nombre_baru,
    max(prod_precio.nombre) FILTER (WHERE prod_precio.retailer = 'machetazo'::text)  AS nombre_mach,
    max(prod_precio.nombre) FILTER (WHERE prod_precio.retailer = 'ribasmith'::text)  AS nombre_riba,
    max(prod_precio.nombre) FILTER (WHERE prod_precio.retailer = 'msmega'::text)     AS nombre_msmega,
    count(DISTINCT prod_precio.retailer) AS n_tiendas
  FROM prod_precio
  GROUP BY prod_precio.ean_key
), calc AS (
  SELECT por_ean.*,
    LEAST(por_ean.precio_xtra, por_ean.precio_rey, por_ean.precio_99, por_ean.precio_carnes, por_ean.precio_baru, por_ean.precio_mach, por_ean.precio_riba) AS precio_min_retail,
    GREATEST(por_ean.precio_xtra, por_ean.precio_rey, por_ean.precio_99, por_ean.precio_carnes, por_ean.precio_baru, por_ean.precio_mach, por_ean.precio_riba) AS precio_max_retail,
    (por_ean.precio_xtra IS NOT NULL)::integer + (por_ean.precio_rey IS NOT NULL)::integer + (por_ean.precio_99 IS NOT NULL)::integer + (por_ean.precio_carnes IS NOT NULL)::integer + (por_ean.precio_baru IS NOT NULL)::integer + (por_ean.precio_mach IS NOT NULL)::integer + (por_ean.precio_riba IS NOT NULL)::integer AS n_retail
  FROM por_ean
)
SELECT ean_key AS ean, nombre, categoria,
  dealbot_marca(nombre) AS marca,
  dealbot_referencia(nombre) AS referencia,
  precio_xtra, precio_rey, precio_99, precio_carnes, precio_baru, precio_mach, precio_riba, precio_msmega,
  link_xtra, link_rey, link_99, link_carnes, link_baru, link_mach, link_riba, link_msmega,
  nombre_xtra, nombre_rey, nombre_99, nombre_carnes, nombre_baru, nombre_mach, nombre_riba, nombre_msmega,
  n_tiendas, n_retail, precio_min_retail, precio_max_retail,
  CASE WHEN n_retail >= 2 THEN round(precio_max_retail - precio_min_retail, 2) ELSE NULL::numeric END AS ahorro_abs,
  CASE WHEN n_retail >= 2 AND precio_max_retail > 0::numeric THEN round((precio_max_retail - precio_min_retail) / precio_max_retail * 100::numeric, 1) ELSE NULL::numeric END AS ahorro_pct,
  CASE WHEN n_retail >= 2 THEN
    CASE
      WHEN precio_xtra = precio_min_retail THEN 'SuperXtra'::text
      WHEN precio_rey = precio_min_retail THEN 'Super Rey'::text
      WHEN precio_99 = precio_min_retail THEN 'Super99'::text
      WHEN precio_carnes = precio_min_retail THEN 'SuperCarnes'::text
      WHEN precio_baru = precio_min_retail THEN 'Super Barú'::text
      WHEN precio_mach = precio_min_retail THEN 'El Machetazo'::text
      WHEN precio_riba = precio_min_retail THEN 'Riba Smith'::text
      ELSE NULL::text
    END
  ELSE NULL::text END AS tienda_mas_barata
FROM calc
WHERE n_tiendas >= 2
ORDER BY (CASE WHEN n_retail >= 2 AND precio_max_retail > 0::numeric THEN round((precio_max_retail - precio_min_retail) / precio_max_retail * 100::numeric, 1) ELSE NULL::numeric END) DESC NULLS LAST;
