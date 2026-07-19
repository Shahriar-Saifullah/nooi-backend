import { Router } from 'express';
import multer from 'multer';
import { requireAuth } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate';
import {
  createProjectSchema,
  saveRoomsSchema,
  saveDimensionsSchema,
  saveFurnitureSchema,
  updateProjectSchema,
  generateRenderSchema,
  toggleShareSchema,
} from '../schemas/project.schema';
import {
  createProject,
  uploadFloorPlan,
  saveRooms,
  saveDimensions,
  saveFurniture,
  confirmProject,
  getProjects,
  getProject,
  updateProject,
  deleteProject,
  generateRender,
  toggleShare,
} from '../controllers/project.controller';

const router = Router();

// Multer — memory storage, 20MB limit
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 20 * 1024 * 1024 },
});

// ─── Project creation flow ────────────────────────────────────────────────────

router.post('/',                requireAuth, validate(createProjectSchema), createProject);
router.post('/:id/floor-plan',  requireAuth, upload.single('floor_plan'),   uploadFloorPlan);
router.put('/:id/rooms',        requireAuth, validate(saveRoomsSchema),     saveRooms);
router.put('/:id/dimensions',   requireAuth, validate(saveDimensionsSchema),saveDimensions);
router.put('/:id/furniture',    requireAuth, validate(saveFurnitureSchema), saveFurniture);
router.post('/:id/confirm',     requireAuth,                                confirmProject);
router.post('/:id/generate-render', requireAuth, validate(generateRenderSchema), generateRender);
router.post('/:id/share',       requireAuth, validate(toggleShareSchema),   toggleShare);

// ─── Standard CRUD ────────────────────────────────────────────────────────────

router.get('/',    requireAuth, getProjects);
router.get('/:id', requireAuth, getProject);
router.put('/:id', requireAuth, validate(updateProjectSchema), updateProject);
router.delete('/:id', requireAuth, deleteProject);

export default router;