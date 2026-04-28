import 'dotenv/config'; // 👈 MUST BE FIRST LINE
import cookieParser from 'cookie-parser';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

import authRoutes     from './routes/auth.routes';
import projectRoutes from './routes/projects.routes';
import aiRoutes       from './routes/ai.routes';
import orderRoutes    from './routes/orders.routes';
import { errorHandler } from './middleware/errorHandler';
import onboardingRoutes from './routes/onboarding.routes';
import profileRoutes from './routes/profile.routes';




const app = express();
const PORT = process.env.PORT || 3001;

// Security
app.use(helmet());
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 100 }));

// Middleware
const allowedOrigins = process.env.FRONTEND_URL
  ? process.env.FRONTEND_URL.split(',').map(url => url.trim())
  : [];
app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use(express.json());
app.use(cookieParser());

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', project: 'nooi-backend' });
});

// Routes
app.use('/auth', authRoutes);
app.use('/projects', projectRoutes);
app.use('/ai', aiRoutes);
app.use('/orders', orderRoutes);
app.use('/onboarding', onboardingRoutes);
app.use('/profile', profileRoutes);

// Error handler
app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`Nooi backend running on port ${PORT}`);
});

export default app;
