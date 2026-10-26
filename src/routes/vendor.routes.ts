import { Router } from 'express';
import {
  getVendorProfile,
  updateVendorProfile,
  getVendorDashboardSummary,
  getVendorOrders,
  getVendorShipment,
  dispatchShipment,
  advanceShipmentStatus,
  getVendorPayments,
  getVendorPayoutAccount,
  saveVendorPayoutAccount,
} from '../controllers/vendor.controller';
import { requireVendor } from '../middleware/auth.middleware';
import { requestShipmentCancellation, getShipmentCancellation } from '../controllers/cancellations.controller';
import { validate } from '../middleware/validate';
import { updateVendorProfileSchema } from '../schemas/auth.schema';

const router = Router();

// All vendor routes require authenticated user with role='vendor'
router.get('/profile', requireVendor, getVendorProfile);
router.put('/profile', requireVendor, validate(updateVendorProfileSchema), updateVendorProfile);
router.get('/dashboard-summary', requireVendor, getVendorDashboardSummary);

// Earnings and payouts
router.get('/payments',        requireVendor, getVendorPayments);
router.get('/payout-account',  requireVendor, getVendorPayoutAccount);
router.put('/payout-account',  requireVendor, saveVendorPayoutAccount);

  router.get('/orders',                       requireVendor, getVendorOrders);
  router.get('/orders/:shipmentId/cancellation',  requireVendor, getShipmentCancellation);
  router.post('/orders/:shipmentId/cancellation', requireVendor, requestShipmentCancellation);
  router.get('/orders/:shipmentId',           requireVendor, getVendorShipment);
  router.post('/orders/:shipmentId/dispatch', requireVendor, dispatchShipment);
  router.post('/orders/:shipmentId/status',   requireVendor, advanceShipmentStatus);

export default router;
