import { Router } from 'express';
import {
  signup, login, logout, getMe, googleSignIn, authCallback,
  forgotPassword, resetPassword, resendVerification,
} from '../controllers/auth.controller';
import { validate }     from '../middleware/validate';
import { requireAuth }  from '../middleware/auth.middleware';
import {
  signupSchema, loginSchema,
  forgotPasswordSchema, resetPasswordSchema, resendVerificationSchema,
} from '../schemas/auth.schema';

const router = Router();

router.get('/google',   googleSignIn);
router.get('/callback', authCallback);

router.post('/signup',  validate(signupSchema), signup);
router.post('/login',   validate(loginSchema),  login);
router.post('/logout',  requireAuth, logout);
router.get('/me',       requireAuth, getMe);
router.post('/forgot-password', validate(forgotPasswordSchema), forgotPassword);
router.post('/reset-password',  validate(resetPasswordSchema), resetPassword);
router.post('/resend-verification',  validate(resendVerificationSchema),  resendVerification);

export default router;
