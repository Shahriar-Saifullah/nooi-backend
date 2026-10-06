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
  decideVendorApplication,
} from '../controllers/admin.controller';
import { requireAdmin } from '../middleware/auth.middleware';
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

export default router;