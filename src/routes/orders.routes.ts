import { Router } from 'express';
import {
  createOrderCheckout,
  getUserOrders,
  getOrderById,
  submitReturnRequest,
} from '../controllers/orders.controller';
import { requireAuth } from '../middleware/auth.middleware';

const router = Router();

router.post('/checkout', createOrderCheckout);
router.get('/', requireAuth, getUserOrders);
router.get('/:id', requireAuth, getOrderById);
router.post('/:id/returns', requireAuth, submitReturnRequest);

export default router;
