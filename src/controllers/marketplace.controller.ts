import { Request, Response } from 'express';
import { supabase } from '../services/supabase';

const DEFAULT_LEAD_TIME_DAYS = 14;
 
/** product → retailer policy → global default. Mirrors products_shop. */
function resolveLeadTime(product: any): number {
  if (product.lead_time_days != null) return Number(product.lead_time_days);
 
  const policy = product.retailers?.shipping_policy_json;
  const fromPolicy =
    typeof policy === 'string'
      ? (() => { try { return JSON.parse(policy)?.lead_time_days; } catch { return null; } })()
      : policy?.lead_time_days;
 
  if (fromPolicy != null && !Number.isNaN(Number(fromPolicy))) return Number(fromPolicy);
  return DEFAULT_LEAD_TIME_DAYS;
}
 
/**
 * Shape a raw row for the grid. Keeps the response narrow and does the two
 * things the UI can't: resolve lead time, and drop the retailer's policy blob.
 */
function shapeForGrid(row: any) {
  const variants = (row.product_variants ?? []).filter((v: any) => v.is_active);
  const inStock = variants.some((v: any) => v.stock_quantity > 0);
  const prices = variants.map((v: any) => Number(v.price)).filter((n: number) => !Number.isNaN(n));
 
  const { shipping_policy_json, ...retailer } = row.retailers ?? {};
 
  return {
    id: row.id,
    canvas_model_id: row.canvas_model_id,
    type_id: row.type_id,
    title: row.title,
    description: row.description,
    category: row.category,
    tags: row.tags ?? [],
    base_price: Number(row.base_price),
    /** Lowest active variant price — what the card should show. */
    from_price: prices.length ? Math.min(...prices) : Number(row.base_price),
    affiliate_url: row.affiliate_url,
    specs_json: row.specs_json ?? {},
    lead_time_days: resolveLeadTime(row),
    shop_group: row.furniture_types?.shop_group ?? 'Other',
    type_name: row.furniture_types?.name ?? null,
    /** True when a placed 3D model maps to this product. Drives the badge. */
    is_3d: Boolean(row.canvas_model_id),
    in_stock: inStock,
    retailer: retailer.id ? retailer : null,
    variants,
  };
}

// Mock catalog fallback for local dev / demonstration when DB is empty
const MOCK_PRODUCTS = [
  {
    id: 'prod-001',
    retailer_id: 'ret-westelm',
    canvas_model_id: 'sofa_modern_01',
    title: 'Haven Leather Sofa',
    description: 'Deep, plush seating wrapped in top-grain Italian leather with hand-carved solid oak legs.',
    category: 'Living Room',
    tags: ['leather', 'sofa', 'modern', 'living-room'],
    base_price: 1899.00,
    affiliate_url: 'https://www.westelm.com/products/haven-leather-sofa',
    specs_json: {
      dimensions_cm: { width: 220, height: 85, depth: 95 },
      material: 'Top-Grain Leather & Solid Oak',
      weight_kg: 68,
      assembly_required: false,
      warranty: '5-Year Frame Warranty',
      shipping_days: '3-5 business days'
    },
    retailers: { name: 'West Elm', logo_url: '/assets/westelm.png', commission_rate: 8.5 },
    product_variants: [
      { id: 'var-001-a', sku: 'HVS-COG-220', color: 'Cognac', material: 'Leather', price: 1899.00, stock_quantity: 12, images: ['/assets/sofa.png'], is_active: true },
      { id: 'var-001-b', sku: 'HVS-BLK-220', color: 'Midnight Black', material: 'Leather', price: 1999.00, stock_quantity: 5, images: ['/assets/sofa.png'], is_active: true }
    ],
    reviews_count: 24,
    rating: 4.8
  },
  {
    id: 'prod-002',
    retailer_id: 'ret-noguchi',
    canvas_model_id: 'lamp_akari_1a',
    title: 'Akari 1A Table Lamp',
    description: 'Designed by Isamu Noguchi. Handcrafted in Gifu, Japan using traditional Mino wash paper.',
    category: 'Lighting',
    tags: ['lighting', 'lamp', 'japanese', 'paper'],
    base_price: 350.00,
    affiliate_url: 'https://shop.noguchi.org/products/akari-1a',
    specs_json: {
      dimensions_cm: { width: 26, height: 43, depth: 26 },
      material: 'Shoji Paper & Bamboo Wire',
      weight_kg: 1.2,
      assembly_required: true,
      warranty: '1-Year Limited Warranty',
      shipping_days: '2-4 business days'
    },
    retailers: { name: 'Noguchi Shop', logo_url: '/assets/logo.png', commission_rate: 10.0 },
    product_variants: [
      { id: 'var-002-a', sku: 'AKR-1A-WHT', color: 'Warm White', material: 'Shoji Paper', price: 350.00, stock_quantity: 28, images: ['/assets/lighting.png'], is_active: true }
    ],
    reviews_count: 42,
    rating: 4.9
  },
  {
    id: 'prod-003',
    retailer_id: 'ret-hay',
    canvas_model_id: 'chair_slits_01',
    title: 'Palissade Lounge Chair',
    description: 'Powder-coated steel outdoor lounge chair designed by Ronan & Erwan Bouroullec.',
    category: 'Seating',
    tags: ['outdoor', 'chair', 'modern', 'steel'],
    base_price: 495.00,
    affiliate_url: 'https://hay.dk/products/palissade-lounge-chair',
    specs_json: {
      dimensions_cm: { width: 73, height: 70, depth: 81 },
      material: 'Powder-Coated Electro-Galvanized Steel',
      weight_kg: 14.5,
      assembly_required: false,
      warranty: '3-Year Weather Guarantee',
      shipping_days: '4-7 business days'
    },
    retailers: { name: 'HAY Design', logo_url: '/assets/logo.png', commission_rate: 7.0 },
    product_variants: [
      { id: 'var-003-a', sku: 'PLS-OLV-01', color: 'Olive Green', material: 'Steel', price: 495.00, stock_quantity: 19, images: ['/assets/furniture.png'], is_active: true },
      { id: 'var-003-b', sku: 'PLS-ANT-01', color: 'Anthracite', material: 'Steel', price: 495.00, stock_quantity: 8, images: ['/assets/furniture.png'], is_active: true }
    ],
    reviews_count: 18,
    rating: 4.7
  },
  {
    id: 'prod-004',
    retailer_id: 'ret-cb2',
    canvas_model_id: 'table_marble_01',
    title: 'Stretto White Marble Dining Table',
    description: 'Solid Carrara marble top with brass-finished steel pedestal base.',
    category: 'Dining',
    tags: ['dining', 'table', 'marble', 'brass'],
    base_price: 1499.00,
    affiliate_url: 'https://www.cb2.com/stretto-marble-dining-table',
    specs_json: {
      dimensions_cm: { width: 180, height: 76, depth: 90 },
      material: 'Carrara Marble & Plated Steel',
      weight_kg: 92,
      assembly_required: true,
      warranty: '2-Year Craftsmanship Warranty',
      shipping_days: '5-10 business days'
    },
    retailers: { name: 'CB2', logo_url: '/assets/logo.png', commission_rate: 6.0 },
    product_variants: [
      { id: 'var-004-a', sku: 'STR-MRB-180', color: 'White Marble / Brass', material: 'Marble', price: 1499.00, stock_quantity: 6, images: ['/assets/decor.png'], is_active: true }
    ],
    reviews_count: 15,
    rating: 4.6
  }
];

export const getProducts = async (req: Request, res: Response) => {
  try {
    const {
      group,            // shop group chip: Seating, Tables, ...
      category,         // room category: living, bedroom, ...
      type_id,          // exact furniture type — powers "similar items"
      exclude_model,    // omit one canvas_model_id, so the exact match isn't listed twice
      retailer_id,      // vendor filter
      search,
      min_price,
      max_price,
      in_stock,         // 'true' to hide sold-out
      sort,             // price_asc | price_desc | lead_time | newest
      page = 1,
      limit = 12,
    } = req.query;
 
    // !inner on furniture_types so the group filter can apply to the embed.
    // shipping_policy_json is pulled only to resolve lead time; shapeForGrid
    // strips it before the response.
    let query = supabase
      .from('products')
      .select(
        `id, retailer_id, canvas_model_id, type_id, title, description,
         category, tags, base_price, affiliate_url, specs_json, lead_time_days,
         created_at,
         furniture_types!inner(id, name, shop_group, group_sort),
         retailers(id, name, logo_url, shipping_policy_json),
         product_variants(*)`,
        { count: 'exact' },
      );
 
    if (group && group !== 'All') {
      query = query.eq('furniture_types.shop_group', String(group));
    }
    if (category && category !== 'All') {
      query = query.ilike('category', `%${category}%`);
    }
    if (type_id) {
      query = query.eq('type_id', String(type_id));
    }
    if (exclude_model) {
      query = query.neq('canvas_model_id', String(exclude_model));
    }
    if (retailer_id && retailer_id !== 'All') {
      query = query.eq('retailer_id', String(retailer_id));
    }
    if (search) {
      query = query.or(`title.ilike.%${search}%,description.ilike.%${search}%`);
    }
    if (min_price) {
      query = query.gte('base_price', Number(min_price));
    }
    if (max_price) {
      query = query.lte('base_price', Number(max_price));
    }
 
    if (sort === 'price_asc') {
      query = query.order('base_price', { ascending: true });
    } else if (sort === 'price_desc') {
      query = query.order('base_price', { ascending: false });
    } else if (sort === 'lead_time') {
      // NULLs sort last so products without a stated lead time don't claim to
      // be the fastest.
      query = query.order('lead_time_days', { ascending: true, nullsFirst: false });
    } else {
      query = query.order('created_at', { ascending: false });
    }
 
    const from = (Number(page) - 1) * Number(limit);
    query = query.range(from, from + Number(limit) - 1);
 
    const { data, count, error } = await query;
 
    if (error) {
      console.error('[marketplace] getProducts failed:', error);
      return res.status(500).json({ success: false, error: error.message });
    }
 
    let products = (data ?? []).map(shapeForGrid);
 
    // Stock filter runs after shaping — whether a product is buyable depends on
    // its variants, which a column filter can't see.
    if (String(in_stock) === 'true') {
      products = products.filter(p => p.in_stock);
    }
 
    return res.json({
      success: true,
      products,
      total: count ?? products.length,
      page: Number(page),
      limit: Number(limit),
    });
  } catch (err: any) {
    console.error('[marketplace] getProducts threw:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

export const getProductById = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from('products')
      .select('*, retailers(id, name, logo_url), product_variants(*), product_reviews(*)')
      .eq('id', id)
      .single();

    if (error || !data) {
      const mock = MOCK_PRODUCTS.find(p => p.id === id) || MOCK_PRODUCTS[0];
      return res.json({ success: true, product: mock, is_mock: true });
    }

    return res.json({ success: true, product: data, is_mock: false });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const addProductReview = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { rating, comment } = req.body;
    const userId = (req as any).user?.id;
    const userName = (req as any).user?.email?.split('@')[0] || 'Verified Buyer';

    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({ success: false, message: 'Rating must be between 1 and 5' });
    }

    const { data, error } = await supabase
      .from('product_reviews')
      .insert({
        product_id: id,
        user_id: userId,
        user_name: userName,
        rating,
        comment
      })
      .select()
      .single();

    if (error) {
      return res.json({
        success: true,
        review: { id: `rev-${Date.now()}`, product_id: id, user_name: userName, rating, comment, created_at: new Date().toISOString() },
        is_mock: true
      });
    }

    return res.json({ success: true, review: data });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const getCanvasProductLink = async (req: Request, res: Response) => {
  try {
    const { canvasModelId } = req.params;
 
    const { data, error } = await supabase
      .from('products')
      .select(
        `id, retailer_id, canvas_model_id, type_id, title, description,
         category, tags, base_price, affiliate_url, specs_json, lead_time_days,
         created_at,
         furniture_types(id, name, shop_group, group_sort),
         retailers(id, name, logo_url, shipping_policy_json),
         product_variants(*)`,
      )
      .eq('canvas_model_id', canvasModelId);
 
    if (error) {
      console.error('[canvas-link] query failed:', error);
      return res.status(500).json({ success: false, error: error.message });
    }
 
    // No match is an ordinary outcome — the catalogue has 43 models and no
    // vendor carries all of them. The client falls back to a type-level match,
    // which it can only do if we tell the truth here.
    return res.json({
      success: true,
      products: (data ?? []).map(shapeForGrid),
    });
  } catch (err: any) {
    console.error('[canvas-link] threw:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const trackAffiliateClick = async (req: Request, res: Response) => {
  try {
    const { product_id, retailer_id, referrer } = req.query;
    const userId = (req as any).user?.id || null;

    const productId = String(product_id || '');
    if (!productId) {
      return res.status(400).json({ success: false, message: 'product_id is required' });
    }

    // Resolve the destination before logging. If the product is gone there is
    // nowhere to send the shopper, and recording a click for it is noise.
    const { data: product, error } = await supabase
      .from('products')
      .select('affiliate_url, retailer_id')
      .eq('id', productId)
      .maybeSingle();

    if (error) console.error('[affiliate] lookup failed:', error);

    if (!product) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    // Trust the product's own retailer over whatever the caller passed, so a
    // tampered query string can't attribute a click to someone else's payout.
    const { error: insertError } = await supabase.from('affiliate_clicks').insert({
      user_id: userId,
      product_id: productId,
      retailer_id: product.retailer_id ?? String(retailer_id || ''),
      referrer_page: String(referrer || 'marketplace'),
    });

    // Tracking must never block the shopper from reaching the retailer.
    if (insertError) console.error('[affiliate] click not recorded:', insertError);

    return res.json({
      success: true,
      target_url: product.affiliate_url || 'https://nooi.design',
    });
  } catch (err: any) {
    console.error('[affiliate] trackAffiliateClick threw:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const getFacets = async (_req: Request, res: Response) => {
  try {
    const [groupsRes, vendorsRes, priceRes] = await Promise.all([
      supabase.from('products_shop').select('shop_group, group_sort'),
      supabase.from('retailers').select('id, name, logo_url').order('name'),
      supabase.from('products').select('base_price').order('base_price', { ascending: true }),
    ]);
 
    if (groupsRes.error)  throw groupsRes.error;
    if (vendorsRes.error) throw vendorsRes.error;
    if (priceRes.error)   throw priceRes.error;
 
    const counts = new Map<string, { group: string; sort: number; count: number }>();
    for (const row of groupsRes.data ?? []) {
      const key = row.shop_group ?? 'Other';
      const existing = counts.get(key);
      if (existing) existing.count += 1;
      else counts.set(key, { group: key, sort: row.group_sort ?? 99, count: 1 });
    }
 
    const groups = [...counts.values()].sort((a, b) => a.sort - b.sort);
    const total = groups.reduce((n, g) => n + g.count, 0);
 
    const prices = (priceRes.data ?? []).map(r => Number(r.base_price));
 
    return res.json({
      success: true,
      // "All" first, matching the design's leading chip.
      groups: [{ group: 'All', sort: 0, count: total }, ...groups],
      vendors: vendorsRes.data ?? [],
      price: {
        min: prices.length ? Math.floor(prices[0]) : 0,
        max: prices.length ? Math.ceil(prices[prices.length - 1]) : 0,
      },
    });
  } catch (err: any) {
    console.error('[marketplace] getFacets failed:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};
