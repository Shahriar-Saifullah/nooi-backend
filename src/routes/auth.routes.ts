import { Router } from 'express';
import {
  signup, login, logout, getMe, googleSignIn, authCallback,
  forgotPassword, resetPassword, resendVerification, setSession,
  vendorSignup, vendorLogin, adminLogin,
} from '../controllers/auth.controller';
import { validate } from '../middleware/validate';
import { requireAuth } from '../middleware/auth.middleware';
import {
  signupSchema, loginSchema,
  forgotPasswordSchema, resetPasswordSchema, resendVerificationSchema,
  vendorSignupSchema,
} from '../schemas/auth.schema';

const router = Router();

// OAuth Routes
router.get('/google', googleSignIn);
router.get('/callback', authCallback);

// Standard Customer Auth
router.post('/signup', validate(signupSchema), signup);
router.post('/login', validate(loginSchema), login);

// Vendor Auth Routes
router.post('/vendor/signup', validate(vendorSignupSchema), vendorSignup);
router.post('/vendor/login', validate(loginSchema), vendorLogin);

// Admin Auth Routes
router.post('/admin/login', validate(loginSchema), adminLogin);

// Session & Profile
router.post('/logout', requireAuth, logout);
router.get('/me', requireAuth, getMe);
router.post('/set-session', setSession);

// Password Management & Verification
router.post('/forgot-password', validate(forgotPasswordSchema), forgotPassword);
router.post('/reset-password', validate(resetPasswordSchema), resetPassword);
router.post('/resend-verification', validate(resendVerificationSchema), resendVerification);

export default router;
