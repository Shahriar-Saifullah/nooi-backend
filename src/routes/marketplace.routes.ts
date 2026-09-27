import { Router } from 'express';
import {
  getProducts,
  getProductById,
  getFacets,
  addProductReview,
  getCanvasProductLink,
  trackAffiliateClick,
} from '../controllers/marketplace.controller';
import { requireAuth } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate';
import { addProductReviewSchema } from '../schemas/product.schema';

const router = Router();

router.get('/products', getProducts);
router.get('/products/:id', getProductById);
router.post('/products/:id/reviews', requireAuth, validate(addProductReviewSchema), addProductReview);
router.get('/canvas-link/:canvasModelId', getCanvasProductLink);
router.get('/affiliate/click', trackAffiliateClick);
router.get('/facets', getFacets);

export default router;
