import { Router } from 'express';
import {
  listVendors,
  getVendorById,
  updateVendorStatus,
  listUsers,
  updateUserRole,
  createAdminUser,
  getAdminStats,
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
router.get('/vendors', requireAdmin, listVendors);
router.get('/vendors/:id', requireAdmin, getVendorById);
router.patch('/vendors/:id/status', requireAdmin, validate(updateVendorStatusSchema), updateVendorStatus);

// User & Role Management
router.get('/users', requireAdmin, listUsers);
router.patch('/users/:id/role', requireAdmin, validate(updateUserRoleSchema), updateUserRole);

// Create new administrator
router.post('/create-admin', requireAdmin, validate(createAdminSchema), createAdminUser);

export default router;
