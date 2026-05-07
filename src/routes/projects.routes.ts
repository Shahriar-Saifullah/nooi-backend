import { Router } from 'express';
import {
  createProject,
  getProjects,
  getProject,
  updateProject,
  deleteProject,
} from '../controllers/project.controller';
import { requireAuth }          from '../middleware/auth.middleware';
import { validate }             from '../middleware/validate';
import { createProjectSchema, updateProjectSchema } from '../schemas/project.schema';

const router = Router();

router.post('/',     requireAuth, validate(createProjectSchema), createProject);
router.get('/',      requireAuth, getProjects);
router.get('/:id',   requireAuth, getProject);
router.put('/:id',   requireAuth, validate(updateProjectSchema), updateProject);
router.delete('/:id',requireAuth, deleteProject);

export default router;