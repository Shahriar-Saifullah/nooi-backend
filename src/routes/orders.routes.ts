import { Router } from 'express';
import {
  createPaymentIntent,
  getOrderByPaymentIntent,
  getUserOrders,
  getOrderById,
  submitReturnRequest,
  createMoyasarCheckout,
  bindMoyasarPayment,
  confirmMoyasarPayment,
} from '../controllers/orders.controller';
import { requireAuth } from '../middleware/auth.middleware';

const router = Router();

// Phase 03 Commerce Routes
router.post('/create-payment-intent', requireAuth, createPaymentIntent);
router.get('/by-payment-intent/:pi_id', requireAuth, getOrderByPaymentIntent);

// Moyasar (Saudi Arabia) — see orders.controller for the flow
router.post('/moyasar/checkout', requireAuth, createMoyasarCheckout);
router.post('/moyasar/bind',     requireAuth, bindMoyasarPayment);
router.post('/moyasar/confirm',  requireAuth, confirmMoyasarPayment);

// Customer Order History & Details
router.get('/', requireAuth, getUserOrders);
router.get('/:id', requireAuth, getOrderById);
router.post('/:id/returns', requireAuth, submitReturnRequest);

export default router;
