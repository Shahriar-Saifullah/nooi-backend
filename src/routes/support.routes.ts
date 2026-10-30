import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { listMyTickets, createTicket, getMyTicket, replyToMyTicket } from '../controllers/support.controller';
import { acceptPhotos } from '../services/supportAttachments.service';

// Customers and vendors: their own support tickets.
const router = Router();
router.get('/tickets',               requireAuth, listMyTickets);
router.post('/tickets',              requireAuth, acceptPhotos, createTicket);
router.get('/tickets/:id',           requireAuth, getMyTicket);
router.post('/tickets/:id/messages', requireAuth, acceptPhotos, replyToMyTicket);
export default router;
