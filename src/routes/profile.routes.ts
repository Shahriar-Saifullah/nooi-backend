import { Router } from 'express';
import { updateLanguage, updateProfile } from '../controllers/profile.controller';
import { requireAuth } from '../middleware/auth.middleware';
import { validate }    from '../middleware/validate';
import { updateProfileSchema } from '../schemas/profile.schema';

const router = Router();

router.put('/language/:lang', requireAuth, updateLanguage);
router.put('/',               requireAuth, validate(updateProfileSchema), updateProfile);

export default router;