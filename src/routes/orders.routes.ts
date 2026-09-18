import { Router } from 'express';
import {
  createOrderCheckout,
  getUserOrders,
  getOrderById,
  submitReturnRequest,
} from '../controllers/orders.controller';

const router = Router();

router.post('/checkout', createOrderCheckout);
router.get('/', getUserOrders);
router.get('/:id', getOrderById);
router.post('/:id/returns', submitReturnRequest);

export default router;
