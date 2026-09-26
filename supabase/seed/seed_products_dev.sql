-- Phase 03 — Development seed
-- ============================================================================
-- DEV ONLY. Not a migration — keep this out of the migrations folder so it
-- never runs against production.
--
-- Every canvas_model_id below is a real id from lib/furniture/catalog.ts, and
-- every dimension is derived from that catalog's `size` field. That is the
-- whole point: the canvas→shop bridge is an exact string match, so seed data
-- with invented ids (sofa_modern_01, chair_slits_01) makes the shop look like
-- it works while matching nothing real.
--
-- Deliberately built to exercise the cases the matcher has to get right:
--
--   Same model, several vendors   sofa-3seat has three products from three
--                                 retailers. This is "other vendors sell this".
--
--   Same type, different models   sofa / sofa-2seat / sofa-3seat all carry
--                                 type_id 'sofa', so a query on type_id finds
--                                 related items an exact canvas_model_id match
--                                 never would. This is "similar products".
--
--   Dimension spread              Variants sit slightly above and below the
--                                 catalog size, so ranking by dimension
--                                 distance has something to sort.
--
--   A deliberate misfit           'Grandview Sectional' is far larger than the
--                                 catalog footprint. Your fit check should warn
--                                 on it. If it doesn't, the check isn't wired.
--
--   Out of stock                  One variant has stock_quantity 0 so the
--                                 add-to-cart disabled state is reachable.
--
-- Re-runnable: fixed UUIDs plus ON CONFLICT, so running it twice is a no-op.
-- Run 20260927_shop_match_columns.sql first — this depends on type_id.
-- ============================================================================

-- Retailers -------------------------------------------------------------------

INSERT INTO public.retailers (id, name, logo_url, api_adapter_type, commission_rate) VALUES
  ('a0000000-0000-4000-8000-000000000001', 'Havenly Home',   NULL, 'custom_csv', 12.00),
  ('a0000000-0000-4000-8000-000000000002', 'Nordic Living',  NULL, 'custom_csv', 10.00),
  ('a0000000-0000-4000-8000-000000000003', 'Atelier Maison', NULL, 'custom_csv', 15.00),
  ('a0000000-0000-4000-8000-000000000004', 'Gulf Interiors', NULL, 'custom_csv',  8.50)
ON CONFLICT (id) DO NOTHING;

-- Products --------------------------------------------------------------------
-- canvas_model_id values are verbatim catalog ids. Do not "tidy" the hyphens.

INSERT INTO public.products
  (id, retailer_id, canvas_model_id, type_id, title, description, category, tags, base_price, affiliate_url)
VALUES
  -- sofa-3seat (catalog 220x90x80) — three vendors, one model
  ('b0000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000001','sofa-3seat','sofa',
   'Haven Three-Seat Sofa','Deep-seated three-seater in brushed linen.','living',
   ARRAY['linen','neutral','three-seat'], 1299.00, NULL),
  ('b0000000-0000-4000-8000-000000000002','a0000000-0000-4000-8000-000000000002','sofa-3seat','sofa',
   'Fjord Three Seater','Low Scandinavian frame, solid oak legs.','living',
   ARRAY['oak','scandinavian','three-seat'], 1620.00, NULL),
  ('b0000000-0000-4000-8000-000000000003','a0000000-0000-4000-8000-000000000003','sofa-3seat','sofa',
   'Lowline Sofa','Tight-back three-seater in boucle.','living',
   ARRAY['boucle','minimal','three-seat'], 2150.00, NULL),

  -- sofa-2seat (160x90x80)
  ('b0000000-0000-4000-8000-000000000004','a0000000-0000-4000-8000-000000000001','sofa-2seat','sofa',
   'Haven Loveseat','The two-seat version of the Haven frame.','living',
   ARRAY['linen','neutral','two-seat'], 949.00, NULL),
  ('b0000000-0000-4000-8000-000000000005','a0000000-0000-4000-8000-000000000004','sofa-2seat','sofa',
   'Marsa Two Seater','Compact two-seater for smaller rooms.','living',
   ARRAY['compact','two-seat'], 780.00, NULL),

  -- sofa (230x95x85)
  ('b0000000-0000-4000-8000-000000000006','a0000000-0000-4000-8000-000000000002','sofa','sofa',
   'Bergen Wide Sofa','Generous seat depth, feather-blend cushions.','living',
   ARRAY['wide','feather'], 1890.00, NULL),
  ('b0000000-0000-4000-8000-000000000007','a0000000-0000-4000-8000-000000000003','sofa','sofa',
   'Atelier Classic Sofa','Rolled arm, walnut feet.','living',
   ARRAY['classic','walnut'], 2420.00, NULL),

  -- sofa-boca-tommy (444x173x74) — large sectional, plus a deliberate misfit
  ('b0000000-0000-4000-8000-000000000008','a0000000-0000-4000-8000-000000000003','sofa-boca-tommy','sofa',
   'Boca Modular Sectional','Four-piece modular sectional.','living',
   ARRAY['modular','sectional','large'], 5400.00, NULL),
  ('b0000000-0000-4000-8000-000000000009','a0000000-0000-4000-8000-000000000004','sofa-boca-tommy','sofa',
   'Grandview Sectional','Oversized sectional — check your clearances.','living',
   ARRAY['sectional','oversized'], 6100.00, NULL),

  -- armchair (85x80x80)
  ('b0000000-0000-4000-8000-000000000010','a0000000-0000-4000-8000-000000000001','armchair','armchair',
   'Haven Armchair','Matches the Haven sofa frame.','living',
   ARRAY['linen','neutral'], 549.00, NULL),
  ('b0000000-0000-4000-8000-000000000011','a0000000-0000-4000-8000-000000000002','armchair','armchair',
   'Fjord Lounge Chair','Moulded shell, oak base.','living',
   ARRAY['oak','scandinavian'], 690.00, NULL),
  ('b0000000-0000-4000-8000-000000000012','a0000000-0000-4000-8000-000000000003','armchair','armchair',
   'Sculpt Accent Chair','Curved boucle accent chair.','living',
   ARRAY['boucle','accent'], 880.00, NULL),

  -- coffee-table (120x60x45)
  ('b0000000-0000-4000-8000-000000000013','a0000000-0000-4000-8000-000000000001','coffee-table','coffee-table',
   'Haven Coffee Table','Oak top, powder-coated steel frame.','living',
   ARRAY['oak','steel'], 420.00, NULL),
  ('b0000000-0000-4000-8000-000000000014','a0000000-0000-4000-8000-000000000003','coffee-table','coffee-table',
   'Travertine Coffee Table','Solid travertine, rounded edge.','living',
   ARRAY['stone','travertine'], 1150.00, NULL),
  ('b0000000-0000-4000-8000-000000000015','a0000000-0000-4000-8000-000000000004','coffee-table','coffee-table',
   'Marsa Low Table','Walnut veneer with a lower profile.','living',
   ARRAY['walnut','low'], 360.00, NULL),

  -- side-table (50x50x55)
  ('b0000000-0000-4000-8000-000000000016','a0000000-0000-4000-8000-000000000002','side-table','side-table',
   'Fjord Side Table','Round oak side table.','decor', ARRAY['oak','round'], 190.00, NULL),
  ('b0000000-0000-4000-8000-000000000017','a0000000-0000-4000-8000-000000000003','side-table','side-table',
   'Pedestal Side Table','Cast stone pedestal.','decor', ARRAY['stone'], 340.00, NULL),

  -- dining-table (180x95x76)
  ('b0000000-0000-4000-8000-000000000018','a0000000-0000-4000-8000-000000000001','dining-table','dining-table',
   'Haven Dining Table','Seats six, solid oak.','dining', ARRAY['oak','six-seat'], 1480.00, NULL),
  ('b0000000-0000-4000-8000-000000000019','a0000000-0000-4000-8000-000000000004','dining-table','dining-table',
   'Marsa Dining Table','Ceramic top, matte black legs.','dining', ARRAY['ceramic','black'], 1120.00, NULL),

  -- dining-chair (48x52x92)
  ('b0000000-0000-4000-8000-000000000020','a0000000-0000-4000-8000-000000000001','dining-chair','dining-chair',
   'Haven Dining Chair','Upholstered seat, oak frame.','dining', ARRAY['oak','upholstered'], 220.00, NULL),
  ('b0000000-0000-4000-8000-000000000021','a0000000-0000-4000-8000-000000000002','dining-chair','dining-chair',
   'Fjord Dining Chair','Bentwood back.','dining', ARRAY['bentwood'], 260.00, NULL),
  ('b0000000-0000-4000-8000-000000000022','a0000000-0000-4000-8000-000000000003','dining-chair','dining-chair',
   'Sculpt Dining Chair','Moulded shell on tapered legs.','dining', ARRAY['moulded'], 310.00, NULL),

  -- bed-queen (160x200x100)
  ('b0000000-0000-4000-8000-000000000023','a0000000-0000-4000-8000-000000000001','bed-queen','bed',
   'Haven Queen Bed','Upholstered headboard, slatted base.','bedroom',
   ARRAY['upholstered','queen'], 1350.00, NULL),
  ('b0000000-0000-4000-8000-000000000024','a0000000-0000-4000-8000-000000000002','bed-queen','bed',
   'Fjord Queen Bed','Solid oak platform bed.','bedroom', ARRAY['oak','queen'], 1690.00, NULL),

  -- nightstand (55x45x55)
  ('b0000000-0000-4000-8000-000000000025','a0000000-0000-4000-8000-000000000001','nightstand','nightstand',
   'Haven Nightstand','Two drawers, soft close.','bedroom', ARRAY['oak','drawers'], 290.00, NULL),
  ('b0000000-0000-4000-8000-000000000026','a0000000-0000-4000-8000-000000000004','nightstand','nightstand',
   'Marsa Nightstand','Open shelf, matte finish.','bedroom', ARRAY['matte','open'], 175.00, NULL),

  -- floor-lamp (35x35x160)
  ('b0000000-0000-4000-8000-000000000027','a0000000-0000-4000-8000-000000000002','floor-lamp','floor-lamp',
   'Arc Floor Lamp','Brushed brass, linen shade.','living', ARRAY['brass','linen'], 310.00, NULL),
  ('b0000000-0000-4000-8000-000000000028','a0000000-0000-4000-8000-000000000003','floor-lamp','floor-lamp',
   'Paper Floor Lamp','Rice paper column shade.','living', ARRAY['paper','warm'], 240.00, NULL),

  -- bookshelf (90x30x180)
  ('b0000000-0000-4000-8000-000000000029','a0000000-0000-4000-8000-000000000002','bookshelf','bookshelf',
   'Fjord Bookshelf','Five shelves, solid oak.','living', ARRAY['oak','five-shelf'], 640.00, NULL),

  -- tv-stand (180x45x55)
  ('b0000000-0000-4000-8000-000000000030','a0000000-0000-4000-8000-000000000001','tv-stand','tv-stand',
   'Haven Media Console','Cable management, two drawers.','living', ARRAY['oak','media'], 720.00, NULL),

  -- rug (200x140x2)
  ('b0000000-0000-4000-8000-000000000031','a0000000-0000-4000-8000-000000000004','rug','rug',
   'Marsa Flatweave Rug','Hand-loomed wool flatweave.','living', ARRAY['wool','flatweave'], 480.00, NULL)
ON CONFLICT (id) DO NOTHING;

-- Variants --------------------------------------------------------------------
-- width/depth/height are the real numbers a shopper would compare against the
-- catalog footprint. Spread intentionally: some under, some over.

INSERT INTO public.product_variants
  (id, product_id, sku, color, material, width_cm, depth_cm, height_cm,
   dimensions_cm, stock_quantity, price, images, is_active)
VALUES
  -- sofa-3seat, catalog 220x90x80
  ('c0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','HAV-S3-OAT','Oatmeal','Linen',
   218,92,78,'{"width":218,"depth":92,"height":78}'::jsonb, 14, 1299.00, '{}', true),
  ('c0000000-0000-4000-8000-000000000002','b0000000-0000-4000-8000-000000000001','HAV-S3-SAGE','Sage','Linen',
   218,92,78,'{"width":218,"depth":92,"height":78}'::jsonb,  6, 1349.00, '{}', true),
  ('c0000000-0000-4000-8000-000000000003','b0000000-0000-4000-8000-000000000002','NOR-FJ3-GRY','Storm Grey','Wool',
   225,88,82,'{"width":225,"depth":88,"height":82}'::jsonb,  9, 1620.00, '{}', true),
  ('c0000000-0000-4000-8000-000000000004','b0000000-0000-4000-8000-000000000003','ATL-LOW-CRM','Cream','Boucle',
   210,90,76,'{"width":210,"depth":90,"height":76}'::jsonb,  0, 2150.00, '{}', true),

  -- sofa-2seat, catalog 160x90x80
  ('c0000000-0000-4000-8000-000000000005','b0000000-0000-4000-8000-000000000004','HAV-S2-OAT','Oatmeal','Linen',
   158,90,78,'{"width":158,"depth":90,"height":78}'::jsonb, 11,  949.00, '{}', true),
  ('c0000000-0000-4000-8000-000000000006','b0000000-0000-4000-8000-000000000005','GLF-M2S-TAN','Tan','Leather',
   165,88,80,'{"width":165,"depth":88,"height":80}'::jsonb,  7,  780.00, '{}', true),

  -- sofa, catalog 230x95x85
  ('c0000000-0000-4000-8000-000000000007','b0000000-0000-4000-8000-000000000006','NOR-BRG-NVY','Navy','Velvet',
   232,96,84,'{"width":232,"depth":96,"height":84}'::jsonb,  5, 1890.00, '{}', true),
  ('c0000000-0000-4000-8000-000000000008','b0000000-0000-4000-8000-000000000007','ATL-CLS-EMR','Emerald','Velvet',
   226,94,86,'{"width":226,"depth":94,"height":86}'::jsonb,  3, 2420.00, '{}', true),

  -- sofa-boca-tommy, catalog 444x173x74 — the second one should trip the fit check
  ('c0000000-0000-4000-8000-000000000009','b0000000-0000-4000-8000-000000000008','ATL-BOCA-SND','Sand','Fabric',
   440,170,74,'{"width":440,"depth":170,"height":74}'::jsonb, 2, 5400.00, '{}', true),
  ('c0000000-0000-4000-8000-000000000010','b0000000-0000-4000-8000-000000000009','GLF-GRV-CHR','Charcoal','Fabric',
   505,198,80,'{"width":505,"depth":198,"height":80}'::jsonb, 2, 6100.00, '{}', true),

  -- armchair, catalog 85x80x80
  ('c0000000-0000-4000-8000-000000000011','b0000000-0000-4000-8000-000000000010','HAV-ARM-OAT','Oatmeal','Linen',
   86,80,79,'{"width":86,"depth":80,"height":79}'::jsonb, 18, 549.00, '{}', true),
  ('c0000000-0000-4000-8000-000000000012','b0000000-0000-4000-8000-000000000011','NOR-LNG-OAK','Natural','Oak',
   82,78,82,'{"width":82,"depth":78,"height":82}'::jsonb, 12, 690.00, '{}', true),
  ('c0000000-0000-4000-8000-000000000013','b0000000-0000-4000-8000-000000000012','ATL-SCP-CRM','Cream','Boucle',
   90,84,78,'{"width":90,"depth":84,"height":78}'::jsonb,  8, 880.00, '{}', true),

  -- coffee-table, catalog 120x60x45
  ('c0000000-0000-4000-8000-000000000014','b0000000-0000-4000-8000-000000000013','HAV-CFT-OAK','Natural','Oak',
   120,60,45,'{"width":120,"depth":60,"height":45}'::jsonb, 22, 420.00, '{}', true),
  ('c0000000-0000-4000-8000-000000000015','b0000000-0000-4000-8000-000000000014','ATL-TRV-BGE','Beige','Travertine',
   130,65,42,'{"width":130,"depth":65,"height":42}'::jsonb,  4, 1150.00, '{}', true),
  ('c0000000-0000-4000-8000-000000000016','b0000000-0000-4000-8000-000000000015','GLF-LOW-WAL','Walnut','Veneer',
   112,58,40,'{"width":112,"depth":58,"height":40}'::jsonb, 15, 360.00, '{}', true),

  -- side-table, catalog 50x50x55
  ('c0000000-0000-4000-8000-000000000017','b0000000-0000-4000-8000-000000000016','NOR-SID-OAK','Natural','Oak',
   48,48,55,'{"width":48,"depth":48,"height":55}'::jsonb, 25, 190.00, '{}', true),
  ('c0000000-0000-4000-8000-000000000018','b0000000-0000-4000-8000-000000000017','ATL-PED-STN','Stone','Cast Stone',
   52,52,58,'{"width":52,"depth":52,"height":58}'::jsonb,  9, 340.00, '{}', true),

  -- dining-table, catalog 180x95x76
  ('c0000000-0000-4000-8000-000000000019','b0000000-0000-4000-8000-000000000018','HAV-DIN-OAK','Natural','Oak',
   180,95,76,'{"width":180,"depth":95,"height":76}'::jsonb,  6, 1480.00, '{}', true),
  ('c0000000-0000-4000-8000-000000000020','b0000000-0000-4000-8000-000000000019','GLF-DIN-BLK','Black','Ceramic',
   190,90,75,'{"width":190,"depth":90,"height":75}'::jsonb,  4, 1120.00, '{}', true),

  -- dining-chair, catalog 48x52x92
  ('c0000000-0000-4000-8000-000000000021','b0000000-0000-4000-8000-000000000020','HAV-DCH-OAT','Oatmeal','Linen',
   48,52,92,'{"width":48,"depth":52,"height":92}'::jsonb, 40, 220.00, '{}', true),
  ('c0000000-0000-4000-8000-000000000022','b0000000-0000-4000-8000-000000000021','NOR-DCH-OAK','Natural','Bentwood',
   46,50,90,'{"width":46,"depth":50,"height":90}'::jsonb, 32, 260.00, '{}', true),
  ('c0000000-0000-4000-8000-000000000023','b0000000-0000-4000-8000-000000000022','ATL-DCH-BLK','Black','Moulded',
   50,54,88,'{"width":50,"depth":54,"height":88}'::jsonb, 18, 310.00, '{}', true),

  -- bed-queen, catalog 160x200x100
  ('c0000000-0000-4000-8000-000000000024','b0000000-0000-4000-8000-000000000023','HAV-BDQ-OAT','Oatmeal','Linen',
   162,205,105,'{"width":162,"depth":205,"height":105}'::jsonb, 5, 1350.00, '{}', true),
  ('c0000000-0000-4000-8000-000000000025','b0000000-0000-4000-8000-000000000024','NOR-BDQ-OAK','Natural','Oak',
   160,200, 95,'{"width":160,"depth":200,"height":95}'::jsonb,  7, 1690.00, '{}', true),

  -- nightstand, catalog 55x45x55
  ('c0000000-0000-4000-8000-000000000026','b0000000-0000-4000-8000-000000000025','HAV-NST-OAK','Natural','Oak',
   55,45,55,'{"width":55,"depth":45,"height":55}'::jsonb, 20, 290.00, '{}', true),
  ('c0000000-0000-4000-8000-000000000027','b0000000-0000-4000-8000-000000000026','GLF-NST-WHT','White','Matte MDF',
   50,42,52,'{"width":50,"depth":42,"height":52}'::jsonb, 26, 175.00, '{}', true),

  -- floor-lamp, catalog 35x35x160
  ('c0000000-0000-4000-8000-000000000028','b0000000-0000-4000-8000-000000000027','NOR-ARC-BRS','Brass','Metal',
   38,38,165,'{"width":38,"depth":38,"height":165}'::jsonb, 14, 310.00, '{}', true),
  ('c0000000-0000-4000-8000-000000000029','b0000000-0000-4000-8000-000000000028','ATL-PAP-WHT','White','Rice Paper',
   34,34,158,'{"width":34,"depth":34,"height":158}'::jsonb, 17, 240.00, '{}', true),

  -- bookshelf, catalog 90x30x180
  ('c0000000-0000-4000-8000-000000000030','b0000000-0000-4000-8000-000000000029','NOR-BKS-OAK','Natural','Oak',
   90,32,182,'{"width":90,"depth":32,"height":182}'::jsonb, 10, 640.00, '{}', true),

  -- tv-stand, catalog 180x45x55
  ('c0000000-0000-4000-8000-000000000031','b0000000-0000-4000-8000-000000000030','HAV-TVS-OAK','Natural','Oak',
   180,45,52,'{"width":180,"depth":45,"height":52}'::jsonb, 11, 720.00, '{}', true),

  -- rug, catalog 200x140x2
  ('c0000000-0000-4000-8000-000000000032','b0000000-0000-4000-8000-000000000031','GLF-RUG-NAT','Natural','Wool',
   200,140,2,'{"width":200,"depth":140,"height":2}'::jsonb, 13, 480.00, '{}', true)
ON CONFLICT (id) DO NOTHING;

-- Sanity checks ---------------------------------------------------------------
-- Run these after seeding. Both must return rows or the bridge is not wired.

-- 1. Exact match — what /marketplace/canvas-link/sofa-3seat should find
-- SELECT p.title, r.name AS retailer, v.price, v.width_cm
-- FROM products p
--   JOIN retailers r ON r.id = p.retailer_id
--   JOIN product_variants v ON v.product_id = p.id
-- WHERE p.canvas_model_id = 'sofa-3seat';

-- 2. Similar items — same type, other models. Needs type_id to exist.
-- SELECT p.canvas_model_id, p.title, v.width_cm
-- FROM products p JOIN product_variants v ON v.product_id = p.id
-- WHERE p.type_id = 'sofa' AND p.canvas_model_id <> 'sofa-3seat'
-- ORDER BY abs(v.width_cm - 220);

-- 3. Fit check — variants too wide for a 220cm slot at 15% tolerance
-- SELECT p.title, v.width_cm FROM products p
--   JOIN product_variants v ON v.product_id = p.id
-- WHERE p.type_id = 'sofa' AND v.width_cm > 220 * 1.15;
