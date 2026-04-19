import { Router } from 'express';
import { AuthService } from '../services/auth.service';
import { validate } from '../middleware/validate';
import { loginSchema } from '../types/auth.types';
import { requireAuth } from '../middleware/auth.middleware';
import { AuthRequest } from '../types';

const router = Router();

// Login route
router.post('/login', validate(loginSchema), async (req, res) => {
  try {
    const { user, session } = await AuthService.login(req.body);
    
    // Set accessToken in HttpOnly cookie
    res.cookie('access_token', session?.access_token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 60 * 60 * 1000, // 1 hour
      path: '/',
    });

    res.json({
      success: true,
      data: {
        id: user.id,
        email: user.email,
        full_name: user.full_name
      }
    });
  } catch (error: any) {
    res.status(401).json({
      success: false,
      error: error.message || 'Login failed'
    });
  }
});

// Logout route
router.post('/logout', requireAuth, async (req, res) => {
  try {
    await AuthService.logout();
    
    // Clear the cookie
    res.clearCookie('access_token');
    
    res.json({ success: true, message: 'Logged out successfully' });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get current user details
router.get('/me', requireAuth, async (req: AuthRequest, res) => {
  try {
    // req.user currently has the raw Supabase user from middleware
    // We can use AuthService to sanitize it or just do it here
    const sanitizedUser = {
      id: req.user?.id,
      email: req.user?.email,
      full_name: req.user?.user_metadata?.full_name || 'No Name'
    };

    res.json({
      success: true,
      data: sanitizedUser
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: 'Failed to fetch user' });
  }
});

// Signup - placeholder for the other engineer
router.post('/signup', (req, res) => {
  res.json({ message: 'Signup - to be implemented by colleague' });
});

export default router;