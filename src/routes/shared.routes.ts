import { Router } from 'express';
import { getSharedProject } from '../controllers/project.controller';

const router = Router();

// Public, read-only. No auth on purpose — access is gated by the
// unguessable share token, and the controller returns a sanitized payload.
router.get('/:token', getSharedProject);

export default router;