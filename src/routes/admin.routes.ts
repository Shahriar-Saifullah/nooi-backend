import { Router } from 'express';
import {
  listVendors,
  getVendorById,
  updateVendorStatus,
  listUsers,
  updateUserRole,
  createAdminUser,
  getAdminStats,
  getVendorQueue,
  getVendorForReview,
  claimVendorReview,
  getTeam,
  inviteTeamMember,
  getAdminOverview,
  getVendorDocumentUrl,
  getAuditLog,
  exportAuditLog,
  getVendorDirectory,
  getReturnsQueue,
  getReturnForReview,
  refundReturn,
  declineReturn,
  decideVendorApplication,
  overrideOrderStatus,
  getOrderForIntervention,
  cancelOrderAsAdmin,
  searchOrders,
  approveOrder,
  getPaymentsOverview,
  listPayouts,
  createPayout,
  refreshPayout,
  getVendorPayoutAccount,
  verifyVendorPayoutAccount,
  markShipmentDelivered,
} from '../controllers/admin.controller';
import { requireAdmin } from '../middleware/auth.middleware';
import {
  listListings, getListing, decideListing,
  listCancellations, getCancellation, approveCancellation, declineCancellation,
  listSupportTickets, getSupportTicket, replySupportTicket, setSupportStatus,
  getPlatformSettings, updatePlatformSettings, getPaymentStatus, getMe, updateMe, changeMyPassword, getOpsCounts,
} from '../controllers/ops.controller';
import {
  listModels, getModelProduct, generateModel, uploadModel,
  approveModelJob, rejectModelJob, cancelModelJob, removeModel, setModelSize, rotateModel,
} from '../controllers/models.controller';
import multer from 'multer';
import { validate } from '../middleware/validate';
import {
  updateVendorStatusSchema,
  updateUserRoleSchema,
  createAdminSchema,
} from '../schemas/auth.schema';

const router = Router();

// All admin routes require role='admin' or 'super_admin'
router.get('/stats', requireAdmin, getAdminStats);

// Vendor Management
//
// `/vendors/queue` is declared BEFORE `/vendors/:id`. Express matches in
// declaration order, so with the parameter route first it would read "queue" as
// an id, look for a vendor with that primary key, and 404 — the queue endpoint
// would never be reached.
router.get('/vendors/queue', requireAdmin, getVendorQueue);
router.get('/vendors', requireAdmin, listVendors);
router.get('/vendors/:id/documents/:kind', requireAdmin, getVendorDocumentUrl);
router.get('/vendors/directory', requireAdmin, getVendorDirectory);
router.get('/vendors/:id/payout-account', requireAdmin, getVendorPayoutAccount);
router.post('/vendors/:id/payout-account/verify', requireAdmin, verifyVendorPayoutAccount);
router.get('/vendors/:id', requireAdmin, getVendorById);
router.get('/vendors/:id/review', requireAdmin, getVendorForReview);
router.post('/vendors/:id/review/claim', requireAdmin, claimVendorReview);
router.post('/vendors/:id/decision', requireAdmin, decideVendorApplication);
router.patch('/vendors/:id/status', requireAdmin, validate(updateVendorStatusSchema), updateVendorStatus);

// User & Role Management
router.get('/users', requireAdmin, listUsers);
router.patch('/users/:id/role', requireAdmin, validate(updateUserRoleSchema), updateUserRole);

// Create new administrator
router.post('/create-admin', requireAdmin, validate(createAdminSchema), createAdminUser);
router.get('/overview', requireAdmin, getAdminOverview);

router.get('/team',         requireAdmin, getTeam);
router.post('/team/invite', requireAdmin, inviteTeamMember);
router.get('/audit',        requireAdmin, getAuditLog);
router.get('/audit/export', requireAdmin, exportAuditLog);

router.get('/returns',              requireAdmin, getReturnsQueue);
router.get('/returns/:id',          requireAdmin, getReturnForReview);
router.post('/returns/:id/refund',  requireAdmin, refundReturn);
router.post('/returns/:id/decline', requireAdmin, declineReturn);

router.get('/orders',               requireAdmin, searchOrders);
router.get('/orders/:id',           requireAdmin, getOrderForIntervention);
router.post('/orders/:id/override', requireAdmin, overrideOrderStatus);
router.post('/orders/:id/cancel',   requireAdmin, cancelOrderAsAdmin);
router.post('/orders/:id/approve',  requireAdmin, approveOrder);
router.post('/orders/:id/shipments/:shipmentId/delivered', requireAdmin, markShipmentDelivered);

// Payments and vendor payouts
router.get('/payments/overview',   requireAdmin, getPaymentsOverview);
router.get('/payouts',             requireAdmin, listPayouts);
router.post('/payouts',            requireAdmin, createPayout);
router.post('/payouts/:id/refresh', requireAdmin, refreshPayout);

// Listing review
router.get('/listings',                 requireAdmin, listListings);
router.get('/listings/:id',             requireAdmin, getListing);
router.post('/listings/:id/decision',   requireAdmin, decideListing);

// 3D models for listings
const glbUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 60 * 1024 * 1024 } });
router.get('/models',                         requireAdmin, listModels);
router.get('/models/products/:id',            requireAdmin, getModelProduct);
router.post('/models/products/:id/generate',  requireAdmin, generateModel);
router.post('/models/products/:id/upload',    requireAdmin, glbUpload.single('file'), uploadModel);
router.post('/models/products/:id/remove',    requireAdmin, removeModel);
router.post('/models/products/:id/size',      requireAdmin, setModelSize);
router.post('/models/rotate',                  requireAdmin, rotateModel);
router.post('/models/jobs/:id/approve',       requireAdmin, approveModelJob);
router.post('/models/jobs/:id/reject',        requireAdmin, rejectModelJob);
router.post('/models/jobs/:id/cancel',        requireAdmin, cancelModelJob);

// Cancellation requests
router.get('/cancellations',              requireAdmin, listCancellations);
router.get('/cancellations/:id',          requireAdmin, getCancellation);
router.post('/cancellations/:id/approve', requireAdmin, approveCancellation);
router.post('/cancellations/:id/decline', requireAdmin, declineCancellation);

// Support tickets
router.get('/support',              requireAdmin, listSupportTickets);
router.get('/support/:id',          requireAdmin, getSupportTicket);
router.post('/support/:id/reply',   requireAdmin, replySupportTicket);
router.post('/support/:id/status',  requireAdmin, setSupportStatus);

// Settings and my account
router.get('/settings',          requireAdmin, getPlatformSettings);
router.put('/settings',          requireAdmin, updatePlatformSettings);
router.get('/settings/payments', requireAdmin, getPaymentStatus);
router.get('/me',                requireAdmin, getMe);
router.put('/me',                requireAdmin, updateMe);
router.put('/me/password',       requireAdmin, changeMyPassword);
router.get('/ops/counts',        requireAdmin, getOpsCounts);

export default router;