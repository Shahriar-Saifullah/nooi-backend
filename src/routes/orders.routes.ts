import { Router } from 'express';
import {
  createPaymentIntent,
  getOrderByPaymentIntent,
  getUserOrders,
  getOrderById,
  submitReturnRequest,
} from '../controllers/orders.controller';
import { requireAuth } from '../middleware/auth.middleware';

const router = Router();

// Phase 03 Commerce Routes
router.post('/create-payment-intent', requireAuth, createPaymentIntent);
router.get('/by-payment-intent/:pi_id', requireAuth, getOrderByPaymentIntent);

// Customer Order History & Details
router.get('/', requireAuth, getUserOrders);
router.get('/:id', requireAuth, getOrderById);
router.post('/:id/returns', requireAuth, submitReturnRequest);

export default router;
