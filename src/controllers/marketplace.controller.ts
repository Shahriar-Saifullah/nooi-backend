import { Request, Response } from 'express';
import { supabase } from '../services/supabase';

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
    const { category, search, min_price, max_price, sort, page = 1, limit = 12 } = req.query;

    let query = supabase
      .from('products')
      .select('*, retailers(id, name, logo_url), product_variants(*)', { count: 'exact' });

    if (category && category !== 'All') {
      query = query.ilike('category', `%${category}%`);
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
    } else {
      query = query.order('created_at', { ascending: false });
    }

    const from = (Number(page) - 1) * Number(limit);
    const to = from + Number(limit) - 1;
    query = query.range(from, to);

    const { data, count, error } = await query;

    if (error || !data || data.length === 0) {
      // Return filtered mock data if DB is not populated yet
      let filtered = [...MOCK_PRODUCTS];

      if (category && category !== 'All') {
        filtered = filtered.filter(p => p.category.toLowerCase().includes(String(category).toLowerCase()));
      }
      if (search) {
        const s = String(search).toLowerCase();
        filtered = filtered.filter(p => p.title.toLowerCase().includes(s) || p.description.toLowerCase().includes(s));
      }
      if (min_price) {
        filtered = filtered.filter(p => p.base_price >= Number(min_price));
      }
      if (max_price) {
        filtered = filtered.filter(p => p.base_price <= Number(max_price));
      }

      if (sort === 'price_asc') {
        filtered.sort((a, b) => a.base_price - b.base_price);
      } else if (sort === 'price_desc') {
        filtered.sort((a, b) => b.base_price - a.base_price);
      }

      return res.json({
        success: true,
        products: filtered,
        total: filtered.length,
        page: Number(page),
        limit: Number(limit),
        is_mock: true
      });
    }

    return res.json({
      success: true,
      products: data,
      total: count || data.length,
      page: Number(page),
      limit: Number(limit),
      is_mock: false
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const getProductById = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from('products')
      .select('*, retailers(*), product_variants(*), product_reviews(*)')
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
      .select('*, retailers(*), product_variants(*)')
      .eq('canvas_model_id', canvasModelId);

    if (error || !data || data.length === 0) {
      const matching = MOCK_PRODUCTS.filter(p => p.canvas_model_id === canvasModelId || p.canvas_model_id.includes('sofa'));
      return res.json({ success: true, products: matching.length ? matching : [MOCK_PRODUCTS[0]], is_mock: true });
    }

    return res.json({ success: true, products: data });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const trackAffiliateClick = async (req: Request, res: Response) => {
  try {
    const { product_id, retailer_id, referrer } = req.query;
    const userId = (req as any).user?.id || null;

    await supabase.from('affiliate_clicks').insert({
      user_id: userId,
      product_id: String(product_id || ''),
      retailer_id: String(retailer_id || ''),
      referrer_page: String(referrer || 'marketplace')
    });

    const mockProduct = MOCK_PRODUCTS.find(p => p.id === product_id);
    const targetUrl = mockProduct ? mockProduct.affiliate_url : 'https://nooi.design';

    return res.json({ success: true, target_url: targetUrl });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message });
  }
};
