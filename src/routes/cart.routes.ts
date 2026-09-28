/**
 * Replacement for src/routes/cart.routes.ts
 * ============================================================================
 * Two problems with the current file.
 *
 * 1. No auth middleware on the item routes, so `(req as any).user?.id` in
 *    addToCart is ALWAYS undefined — even for a signed-in shopper. Every write
 *    falls through to the session branch.
 *
 * 2. That branch defaults to the literal string 'default_session' when no
 *    session id is supplied. Every unidentified visitor therefore shares one
 *    cart row: two people shopping at once see each other's items.
 *
 * Adding requireAuth fixes both. Checkout requires auth anyway, so a guest cart
 * has nowhere to go — guest carts stay in localStorage until sign-in, which
 * also keeps rows out of `cart_items` while its RLS policy still reads
 * `auth.uid() = user_id OR session_id IS NOT NULL` (every guest row readable
 * and writable by anyone with the anon key).
 *
 * If guest server-carts are wanted later, the fix is a real session cookie plus
 * a tightened RLS policy — not a shared constant.
 */

import { Router } from 'express';
import {
  getCart,
  addToCart,
  updateCartItem,
  removeCartItem,
  quoteCart,
  mergeCart,
} from '../controllers/cart.controller';
import { requireAuth } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate';
import { addToCartSchema, updateCartItemSchema } from '../schemas/product.schema';

const router = Router();

router.get('/items', requireAuth, getCart);
router.post('/items', requireAuth, validate(addToCartSchema), addToCart);
router.patch('/items/:id', requireAuth, validate(updateCartItemSchema), updateCartItem);
router.delete('/items/:id', requireAuth, removeCartItem);

// Guest → authenticated conversion. Kept for when guest carts exist server-side.
router.post('/merge', requireAuth, mergeCart);
router.post('/quote', requireAuth, quoteCart);

export default router;