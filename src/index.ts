import 'dotenv/config'; // 👈 MUST BE FIRST LINE

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import cookieParser from 'cookie-parser';

import authRoutes     from './routes/auth.routes';
import projectRoutes  from './routes/projects.routes';
import aiRoutes       from './routes/ai.routes';
import orderRoutes    from './routes/orders.routes';
import { errorHandler } from './middleware/errorHandler';

const app = express();
const PORT = process.env.PORT || 3001;

// Security
app.use(helmet());
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 100 }));

// Middleware
app.use(cors({ origin: process.env.FRONTEND_URL, credentials: true }));
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

// Error handler
app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`Nooi backend running on port ${PORT}`);
});

export default app;
