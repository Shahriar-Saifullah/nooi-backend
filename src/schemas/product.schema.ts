import { z } from 'zod';

// ─── Dimensions Schema ────────────────────────────────────────────────────────
export const productDimensionsSchema = z.object({
  width: z.number().min(0).default(0),
  height: z.number().min(0).default(0),
  depth: z.number().min(0).default(0),
});

export type ProductDimensions = z.infer<typeof productDimensionsSchema>;

// ─── Product Variant Schemas ──────────────────────────────────────────────────
export const createProductVariantSchema = z.object({
  sku: z.string().min(1, 'SKU is required'),
  color: z.string().optional(),
  material: z.string().optional(),
  dimensions_cm: productDimensionsSchema.optional(),
  stock_quantity: z.number().int().min(0).default(0),
  price: z.number().positive('Price must be greater than 0'),
  images: z.array(z.string()).optional().default([]),
  is_active: z.boolean().optional().default(true),
});

export type CreateProductVariantInput = z.infer<typeof createProductVariantSchema>;

export const updateProductVariantSchema = createProductVariantSchema.partial();
export type UpdateProductVariantInput = z.infer<typeof updateProductVariantSchema>;

// ─── Product Specs Schema ─────────────────────────────────────────────────────
export const productSpecsSchema = z.object({
  dimensions_cm: productDimensionsSchema.optional(),
  material: z.string().optional(),
  weight_kg: z.number().min(0).optional(),
  assembly_required: z.boolean().optional(),
  warranty: z.string().optional(),
  shipping_days: z.string().optional(),
}).passthrough();

export type ProductSpecs = z.infer<typeof productSpecsSchema>;

// ─── Product Schemas ──────────────────────────────────────────────────────────
export const createProductSchema = z.object({
  retailer_id: z.string().uuid('Invalid retailer ID').optional(),
  canvas_model_id: z.string().min(1, 'Canvas model ID is required'),
  title: z.string().min(1, 'Title is required').max(200, 'Title must be less than 200 characters'),
  description: z.string().optional(),
  category: z.string().min(1, 'Category is required'),
  tags: z.array(z.string()).optional().default([]),
  base_price: z.number().positive('Base price must be positive'),
  affiliate_url: z.string().url('Invalid affiliate URL').optional().or(z.literal('')),
  specs_json: productSpecsSchema.optional(),
  variants: z.array(createProductVariantSchema).optional(),
});

export type CreateProductInput = z.infer<typeof createProductSchema>;

export const updateProductSchema = createProductSchema.partial();
export type UpdateProductInput = z.infer<typeof updateProductSchema>;

// ─── Product Query Filter Schema ──────────────────────────────────────────────
export const productFilterQuerySchema = z.object({
  category: z.string().optional(),
  search: z.string().optional(),
  min_price: z.coerce.number().min(0).optional(),
  max_price: z.coerce.number().min(0).optional(),
  sort: z.enum(['price_asc', 'price_desc', 'created_at_desc', 'newest']).optional(),
  page: z.coerce.number().int().positive().optional().default(1),
  limit: z.coerce.number().int().positive().max(100).optional().default(12),
});

export type ProductFilterQuery = z.infer<typeof productFilterQuerySchema>;

// ─── Product Review Schema ────────────────────────────────────────────────────
export const addProductReviewSchema = z.object({
  rating: z.number().int().min(1, 'Rating must be at least 1').max(5, 'Rating cannot exceed 5'),
  comment: z.string().min(1, 'Review comment is required').max(2000, 'Comment too long'),
});

export type AddProductReviewInput = z.infer<typeof addProductReviewSchema>;

// ─── Cart Action Schemas ──────────────────────────────────────────────────────
export const addToCartSchema = z.object({
  variant_id: z.string().min(1, 'Variant ID is required'),
  quantity: z.number().int().positive('Quantity must be at least 1').optional().default(1),
  session_id: z.string().optional(),
  product_data: z.record(z.string(), z.unknown()).optional(),
});

export type AddToCartInput = z.infer<typeof addToCartSchema>;

export const updateCartItemSchema = z.object({
  quantity: z.number().int().min(0, 'Quantity cannot be negative'),
  session_id: z.string().optional(),
});

export type UpdateCartItemInput = z.infer<typeof updateCartItemSchema>;
