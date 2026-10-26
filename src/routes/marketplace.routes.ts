import { getSettings } from '../services/settings.service';
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

// Public contact details (admin Settings) for footers, support and receipts.
router.get('/platform-info', async (_req, res) => {
  const s = await getSettings();
  res.json({ success: true, data: {
    support_email: s.support_email, support_phone: s.support_phone,
    legal_name: s.legal_name, legal_address: s.legal_address,
    vat_number: s.vat_number, cr_number: s.cr_number, return_window_days: s.return_window_days,
  } });
});

export default router;
