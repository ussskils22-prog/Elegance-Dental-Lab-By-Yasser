require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const http = require('http');
const { getUploadRoot } = require('./config/uploadPaths');

// Import database connection
const connectDB = require('./config/database');

// Import socket service
const { setupSocket } = require('./services/socketService');

// Import routes
const authRoutes = require('./routes/authRoutes');
const caseRoutes = require('./routes/caseRoutes');
const userRoutes = require('./routes/userRoutes');
const auditRoutes = require('./routes/auditRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const doctorPricingRoutes = require('./routes/doctorPricingRoutes');
const doctorPaymentRoutes = require('./routes/doctorPaymentRoutes');
const printRoutes = require('./routes/printRoutes');
const aiRoutes = require('./routes/aiRoutes');
const monthArchiveRoutes = require('./routes/monthArchiveRoutes');
const settingsRoutes = require('./routes/settingsRoutes');
const materialRoutes = require('./routes/materialRoutes');
const financeRoutes = require('./routes/financeRoutes');
const exocadRoutes = require('./routes/exocadRoutes');
const backupRoutes = require('./routes/backupRoutes');

// Import middleware
const errorHandler = require('./middleware/errorHandler');

// Initialize Express app
const app = express();
const server = http.createServer(app);

// ════════════════════════════════════════════════
// MIDDLEWARE
// ════════════════════════════════════════════════

// Security middleware
app.use(helmet());

// CORS
const allowedOrigins = [
  'http://localhost:4200',
  'https://dental-system-seven.vercel.app'
];
if (process.env.CORS_ORIGIN) allowedOrigins.push(process.env.CORS_ORIGIN);

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin) return callback(null, true);
      // Allow any vercel preview URL for this project
      if (origin.endsWith('.vercel.app')) {
        return callback(null, true);
      }
      if (allowedOrigins.indexOf(origin) !== -1) {
        return callback(null, true);
      }
      var msg = 'The CORS policy for this site does not allow access from the specified Origin.';
      return callback(new Error(msg), false);
    },
    credentials: true,
  })
);

// Body parser
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// Logging
app.use(morgan('combined'));

// Rate limiting
// NOTE: frontend polling + socket refresh can generate many API hits in development.
// Keep production protected while avoiding false lockouts during local testing.
const isProduction = process.env.NODE_ENV === 'production';
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: isProduction ? 800 : 3000,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many requests, please try again later.',
  },
});
app.use('/api/', limiter);

// ════════════════════════════════════════════════
// SOCKET.IO SETUP
// ════════════════════════════════════════════════

setupSocket(server);

// ════════════════════════════════════════════════
// ROUTES
// ════════════════════════════════════════════════

// Health check & Root route
const demoMode = String(process.env.DEMO_MODE || '').toLowerCase() === 'true';

function healthPayload() {
  return {
    success: true,
    message: demoMode ? 'Demo server is running (fake data only)' : 'Server is running',
    timestamp: new Date(),
    billingRevision: 'doctor-charge-2026-09-29',
    demoMode,
  };
}

app.get('/', (req, res) => {
  res.status(200).json({
    success: true,
    message: demoMode
      ? 'Uni Shop Demo API (isolated fake data)'
      : 'Elegance Dental Lab API Backend is running',
    frontend: demoMode
      ? process.env.DEMO_FRONTEND_URL || 'https://elegance-demo.vercel.app'
      : 'https://dental-system-kappa.vercel.app',
    billingRevision: 'doctor-charge-2026-09-29',
    demoMode,
  });
});

app.get('/health', (req, res) => {
  res.status(200).json(healthPayload());
});

app.get('/api/health', (req, res) => {
  res.status(200).json(healthPayload());
});

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/cases', caseRoutes);
app.use('/api/users', userRoutes);
app.use('/api/audit-logs', auditRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/doctor-pricing', doctorPricingRoutes);
app.use('/api/doctor-payments', doctorPaymentRoutes);
app.use('/api/print', printRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/month-archive', monthArchiveRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/materials', materialRoutes);
app.use('/api/finance', financeRoutes);
app.use('/api/exocad', exocadRoutes);
app.use('/api/backup', backupRoutes);

// Static files with proper CORS headers
// Prefer UPLOAD_DIR (Railway Volume). Default local ./uploads is wiped on redeploy.
const uploadRoot = getUploadRoot();
console.log('[uploads] serving from', uploadRoot);
app.use('/uploads', (req, res, next) => {
  res.header('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || 'http://localhost:4200');
  res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
  // Allow frontend on a different origin (e.g. :4200) to render images.
  res.header('Cross-Origin-Resource-Policy', 'cross-origin');
  // Uploaded files use unique names, so long immutable cache is safe and faster.
  res.header('Cache-Control', 'public, max-age=31536000, immutable');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
}, express.static(uploadRoot, { fallthrough: true }));

// Clearer 404 for missing uploaded files (usually wiped after redeploy without a Volume)
app.use('/uploads', (req, res) => {
  res.status(404).json({
    success: false,
    message: 'ملف الرفع غير موجود على السيرفر — ارفع السكان من جديد (بعد إضافة Volume على Railway الملفات هتفضل)',
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Route not found',
  });
});

// Error handler middleware
app.use(errorHandler);

// ════════════════════════════════════════════════
// DATABASE CONNECTION & SERVER START
// ════════════════════════════════════════════════

const PORT = process.env.PORT || 5000;

const startServer = async () => {
  try {
    // Connect to MongoDB
    await connectDB();

    // Ensure print jobs TTL is 7 days (fixes stale 24h Mongo index if present)
    const PrintJob = require('./models/PrintJob');
    if (typeof PrintJob.ensurePrintJobTtlIndex === 'function') {
      await PrintJob.ensurePrintJobTtlIndex();
    }

    // Seed lab materials + load workflow config from AppSettings
    try {
      const { ensureDefaultMaterials, getOrCreateLabSettings } = require('./services/labConfigService');
      const { setWorkflowConfig } = require('./services/caseWorkflowService');
      const seeded = await ensureDefaultMaterials();
      if (seeded.created) console.log(`[lab-config] seeded ${seeded.created} default materials`);
      const lab = await getOrCreateLabSettings();
      setWorkflowConfig(lab.workflow);
      console.log('[lab-config] branding:', lab.branding?.labName || lab.whatsapp?.labName || 'Elegance');
    } catch (e) {
      console.warn('[lab-config] init skipped:', e.message);
    }

    // Start server
    server.listen(PORT, () => {
      console.log(`
╔════════════════════════════════════════╗
║   Dental System Backend Server Ready   ║
╠════════════════════════════════════════╣
║   Port: ${PORT}                           
║   Environment: ${process.env.NODE_ENV}
║   Database: MongoDB
║   Socket.io: Enabled
╚════════════════════════════════════════╝
      `);
      try {
        const { scheduleDailyWhatsAppSummary, reloadWhatsAppConfig } = require('./services/whatsappService');
        scheduleDailyWhatsAppSummary();
        reloadWhatsAppConfig()
          .then((cfg) => {
            if (cfg?.enabled && cfg.provider === 'waweb') {
              console.log('[wa-web] boot: starting WhatsApp Web session…');
              const { startWhatsAppWeb } = require('./services/waWebService');
              return startWhatsAppWeb().then((st) => {
                console.log('[wa-web] boot status:', st?.status, st?.connected ? 'connected' : '');
                return st;
              });
            }
            console.log('[wa-web] boot: skipped (enabled=', !!cfg?.enabled, 'provider=', cfg?.provider || 'none', ')');
            return null;
          })
          .catch((e) => console.warn('[wa-web] boot start skipped:', e.message));
      } catch (e) {
        console.warn('WhatsApp scheduler not started:', e.message);
      }
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

// Handle unhandled promise rejections
process.on('unhandledRejection', (error) => {
  console.error('Unhandled Rejection:', error);
  process.exit(1);
});

// Start the server
startServer();

module.exports = app;
