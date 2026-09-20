import { Router } from 'express';
import {
  getCart,
  addToCart,
  updateCartItem,
  removeCartItem,
  mergeCart,
} from '../controllers/cart.controller';
import { requireAuth } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate';
import { addToCartSchema, updateCartItemSchema } from '../schemas/product.schema';

const router = Router();

router.get('/items', getCart);
router.post('/items', validate(addToCartSchema), addToCart);
router.patch('/items/:id', validate(updateCartItemSchema), updateCartItem);
router.delete('/items/:id', removeCartItem);

// Cart Merge for Guest -> Authenticated user conversion
router.post('/merge', requireAuth, mergeCart);

export default router;
