import { Router } from 'express';
import multer from 'multer';
import { requireAuth } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate';
import {
  createProjectSchema,
  saveRoomsSchema,
  saveDimensionsSchema,
  updateProjectSchema,
} from '../schemas/project.schema';
import {
  createProject,
  uploadFloorPlan,
  saveRooms,
  saveDimensions,
  confirmProject,
  getProjects,
  getProject,
  updateProject,
  deleteProject,
} from '../controllers/project.controller';

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 20 * 1024 * 1024 },
});

router.post('/',                requireAuth, validate(createProjectSchema), createProject);
router.post('/:id/floor-plan',  requireAuth, upload.single('floor_plan'),   uploadFloorPlan);
router.put('/:id/rooms',        requireAuth, validate(saveRoomsSchema),     saveRooms);
router.put('/:id/dimensions',   requireAuth, validate(saveDimensionsSchema),saveDimensions);
router.post('/:id/confirm',     requireAuth,                                confirmProject);

router.get('/',    requireAuth, getProjects);
router.get('/:id', requireAuth, getProject);
router.put('/:id', requireAuth, validate(updateProjectSchema), updateProject);
router.delete('/:id', requireAuth, deleteProject);

export default router;