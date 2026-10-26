import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { listMyTickets, createTicket, getMyTicket, replyToMyTicket } from '../controllers/support.controller';

// Customers and vendors: their own support tickets.
const router = Router();
router.get('/tickets',               requireAuth, listMyTickets);
router.post('/tickets',              requireAuth, createTicket);
router.get('/tickets/:id',           requireAuth, getMyTicket);
router.post('/tickets/:id/messages', requireAuth, replyToMyTicket);
export default router;
