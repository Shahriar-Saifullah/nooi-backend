import { Router } from 'express';
import { signup, login, logout, getMe } from '../controllers/auth.controller';
import { validate }     from '../middleware/validate';
import { requireAuth }  from '../middleware/auth.middleware';
import { signupSchema, loginSchema } from '../schemas/auth.schema';

const router = Router();

router.post('/signup',  validate(signupSchema), signup);
router.post('/login',   validate(loginSchema),  login);
router.post('/logout',  logout);
router.get('/me',       requireAuth, getMe);

export default router;