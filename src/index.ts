import 'dotenv/config'; // MUST BE FIRST LINE
import cookieParser from 'cookie-parser';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

import authRoutes        from './routes/auth.routes';
import vendorRoutes      from './routes/vendor.routes';
import adminRoutes       from './routes/admin.routes';
import projectRoutes     from './routes/projects.routes';
import aiRoutes          from './routes/ai.routes';
import orderRoutes       from './routes/orders.routes';
import marketplaceRoutes from './routes/marketplace.routes';
import cartRoutes        from './routes/cart.routes';
import onboardingRoutes  from './routes/onboarding.routes';
import profileRoutes     from './routes/profile.routes';
import sharedRoutes      from './routes/shared.routes';
import { errorHandler }   from './middleware/errorHandler';

const app = express();
app.set('trust proxy', 1); 
const PORT = process.env.PORT || 3001;

// Security
app.use(helmet());
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 1000 }));

// Middleware
const allowedOrigins = process.env.FRONTEND_URL
  ? process.env.FRONTEND_URL.split(',').map(url => url.trim())
  : [];
app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use(express.json({ limit: '12mb' }));
app.use(cookieParser());

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', project: 'nooi-backend' });
});

// Routes
app.use('/auth', authRoutes);
app.use('/vendor', vendorRoutes);
app.use('/admin', adminRoutes);
app.use('/projects', projectRoutes);
app.use('/ai', aiRoutes);
app.use('/orders', orderRoutes);
app.use('/marketplace', marketplaceRoutes);
app.use('/cart', cartRoutes);
app.use('/onboarding', onboardingRoutes);
app.use('/profile', profileRoutes);
app.use('/shared', sharedRoutes);

// Error handler
app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`Nooi backend running on port ${PORT}`);
});

export default app;
