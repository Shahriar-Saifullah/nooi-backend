import { Router } from 'express';
import {
  getCart,
  addToCart,
  updateCartItem,
  removeCartItem,
} from '../controllers/cart.controller';
import { validate } from '../middleware/validate';
import { addToCartSchema, updateCartItemSchema } from '../schemas/product.schema';

const router = Router();

router.get('/items', getCart);
router.post('/items', validate(addToCartSchema), addToCart);
router.patch('/items/:id', validate(updateCartItemSchema), updateCartItem);
router.delete('/items/:id', removeCartItem);

export default router;
