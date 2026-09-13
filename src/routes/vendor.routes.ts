import { Router } from 'express';
import {
  getVendorProfile,
  updateVendorProfile,
  getVendorDashboardSummary,
} from '../controllers/vendor.controller';
import { requireVendor } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate';
import { updateVendorProfileSchema } from '../schemas/auth.schema';

const router = Router();

// All vendor routes require authenticated user with role='vendor'
router.get('/profile', requireVendor, getVendorProfile);
router.put('/profile', requireVendor, validate(updateVendorProfileSchema), updateVendorProfile);
router.get('/dashboard-summary', requireVendor, getVendorDashboardSummary);

export default router;
